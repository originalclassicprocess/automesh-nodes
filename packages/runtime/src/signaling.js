import { randomBytes, webcrypto } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { isValidAccountId } from '../../protocol/src/bech32m.js';
import { accountIdFromPublicKey } from '../../protocol/src/account-id.js';
import { registrationProofBytes } from '../../protocol/src/registration-proof.js';
import { tokenBucket } from './limits.js';
import { COURIER_PROTOCOL, validateCourierJob } from '../../protocol/src/courier-protocol.js';
import { ATTACHMENT_PROTOCOL, validAttachmentRequest, validAttachmentChunk } from '../../protocol/src/attachment-protocol.js';

import { INTRODUCTION_PROTOCOL, validIntroductionFrame } from '../../protocol/src/introduction.js';

const MAX_SIGNALING_BYTES = 64 * 1024;
const MAX_WATCHED_PEERS = 256;
const HEARTBEAT_MS = 30_000;
const CHALLENGE_TTL_MS = 30_000;
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const isValidAddress = (address, allowDiagnosticPeers) =>
  typeof address === 'string' &&
  (isValidAccountId(address) || (allowDiagnosticPeers && /^peer-[a-z0-9]{8}$/.test(address)));

export function createSignalingRegistry() {
  return { id: randomBytes(16).toString('hex'), peers: new Map(), watchers: new Map(), sockets: new Set() };
}

export function createSignalingServer({
  port = 3001,
  host = '127.0.0.1',
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  httpServer,
  path,
  allowDiagnosticPeers = false,
  registry = createSignalingRegistry(),
  iceMode,
  maxConnections = 256,
  messageRate = 20,
  messageBurst = 512,
  maxBufferedBytes = 256 * 1024,
} = {}) {
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 ||
      !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < MAX_SIGNALING_BYTES ||
      !(messageRate > 0 && messageBurst > 0)) throw new Error('invalid_signaling_limits');
  const originSet = new Set(allowedOrigins);
  const wss = new WebSocketServer({
    ...(httpServer ? { server: httpServer } : { port, host }),
    ...(path ? { path } : {}),
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
    // Browser WebSockets include Origin. Non-browser clients still need the
    // signed registration proof; Origin is only a drive-by browser safeguard.
    verifyClient: ({ origin }) => registry.sockets.size < maxConnections && (!origin || originSet.has(origin)),
  });
  const { peers, watchers } = registry;

  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > maxBufferedBytes) { ws.terminate(); return; }
    ws.send(JSON.stringify(message));
  }

  function notifyWatchers(address, type) {
    for (const ws of watchers.get(address) ?? []) send(ws, { type, address });
  }

  async function verifyRegistration(address, challenge, publicKeyHex, signatureHex) {
    if (!/^04[0-9a-fA-F]{128}$/.test(publicKeyHex) || !/^[0-9a-fA-F]{128}$/.test(signatureHex)) return false;
    const publicKeyBytes = new Uint8Array(Buffer.from(publicKeyHex, 'hex'));
    if (await accountIdFromPublicKey(publicKeyBytes, webcrypto.subtle) !== address) return false;
    try {
      const publicKey = await webcrypto.subtle.importKey(
        'raw', publicKeyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
      );
      return await webcrypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' }, publicKey,
        Buffer.from(signatureHex, 'hex'), registrationProofBytes(address, challenge),
      );
    } catch {
      return false;
    }
  }

  wss.on('connection', (ws) => {
    registry.sockets.add(ws);
    const allowMessage = tokenBucket(messageRate, messageBurst);
    const allowIntroduction = tokenBucket(4, 32);
    const allowIntroductionReceive = tokenBucket(8, 64);
    ws.allowIntroductionReceive = allowIntroductionReceive;
    const allowBytes = tokenBucket(256 * 1024, 1024 * 1024);
    const allowFileBytes = tokenBucket(2 * 1024 * 1024, 4 * 1024 * 1024);
    // Bound raw JSON parsing as well as accepted frames. Invalid JSON must not
    // bypass byte limits; the higher ceiling preserves file-chunk throughput.
    const allowIngressBytes = tokenBucket(2 * 1024 * 1024, 4 * 1024 * 1024);
    let myAddress = null;
    let pendingRegistration = null;
    let alive = true;
    let probeAnswered = false;
    const watchedAddresses = new Set();
    const watch = (address) => {
      if (watchedAddresses.has(address)) return true;
      if (watchedAddresses.size >= MAX_WATCHED_PEERS) {
        send(ws, { type: 'error', reason: 'too_many_watched_peers' });
        return false;
      }
      watchedAddresses.add(address);
      const listeners = watchers.get(address) ?? new Set();
      listeners.add(ws);
      watchers.set(address, listeners);
      return true;
    };
    const registrationTimer = setTimeout(() => {
      if (!myAddress) ws.close(1008, 'registration timeout');
    }, CHALLENGE_TTL_MS);
    registrationTimer.unref?.();

    ws.on('pong', () => { alive = true; });

    function handleMessage(raw, binary) {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (binary || !allowMessage()) {
        ws.close(1008, binary ? 'text frames required' : 'rate limit');
        return;
      }
      if (!allowIngressBytes(raw.length)) { ws.close(1008, 'rate limit'); return; }
      if (!myAddress && raw.length > MAX_SIGNALING_BYTES) { ws.close(1009, 'message too large'); return; }
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        if (raw.length > MAX_SIGNALING_BYTES) { ws.close(1009, 'message too large'); return; }
        if (!allowBytes(raw.length)) { ws.close(1008, 'rate limit'); return; }
        send(ws, { type: 'error', reason: 'invalid_json' });
        return;
      }

      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        send(ws, { type: 'error', reason: 'invalid_message' });
        return;
      }
      if (!(myAddress && msg.type === 'courier_file_chunk' ? allowFileBytes(raw.length) : allowBytes(raw.length))) { ws.close(1008, 'rate limit'); return; }
      if (!['courier_delivery', 'courier_receipt'].includes(msg.type) && raw.length > MAX_SIGNALING_BYTES) {
        ws.close(1009, 'message too large'); return;
      }

      // A bounded, anonymous protocol check: no registry access or presence
      // data, and no registration/identity required for this one response.
      if (msg.type === 'probe' && !myAddress && !pendingRegistration && !probeAnswered) {
        probeAnswered = true;
        send(ws, { type: 'probe_result', protocol: 'mesh-signaling-v1', registryId: registry.id });
        return;
      }

      if (msg.type === 'register') {
        if (myAddress || pendingRegistration || !isValidAddress(msg.address, allowDiagnosticPeers)) {
          ws.close(1008, 'invalid address');
          return;
        }
        if (peers.has(msg.address) && peers.get(msg.address) !== ws) {
          ws.close(1008, 'address in use');
          return;
        }
        if (msg.address.startsWith('peer-')) {
          myAddress = msg.address;
          clearTimeout(registrationTimer);
          peers.set(myAddress, ws);
          send(ws, { type: 'registered', address: myAddress, registryId: registry.id, ...(iceMode ? { iceMode } : {}) });
          notifyWatchers(myAddress, 'peer_online');

          return;
        }
        const challenge = randomBytes(32).toString('hex');
        pendingRegistration = { address: msg.address, challenge, issuedAt: Date.now(), verifying: false };
        send(ws, { type: 'register_challenge', address: msg.address, challenge });
        return;
      }

      if (msg.type === 'register_proof') {
        const pending = pendingRegistration;
        if (!pending || pending.verifying || myAddress ||
            msg.address !== pending.address || Date.now() - pending.issuedAt > CHALLENGE_TTL_MS) {
          ws.close(1008, 'invalid registration proof');
          return;
        }
        pending.verifying = true;
        void verifyRegistration(pending.address, pending.challenge, msg.publicKey, msg.signature)
          .then((valid) => {
            if (!valid || ws.readyState !== WebSocket.OPEN) {
              ws.close(1008, 'invalid registration proof');
              return;
            }
            pendingRegistration = null;
            if (peers.has(pending.address)) {
              ws.close(1008, 'address in use');
              return;
            }
            myAddress = pending.address;
            clearTimeout(registrationTimer);
            peers.set(myAddress, ws);
            send(ws, { type: 'registered', address: myAddress, registryId: registry.id, courierProtocol: COURIER_PROTOCOL, attachmentProtocol: ATTACHMENT_PROTOCOL, introductionProtocol: INTRODUCTION_PROTOCOL, ...(iceMode ? { iceMode } : {}) });
            notifyWatchers(myAddress, 'peer_online');

          })
          .catch(() => ws.close(1008, 'invalid registration proof'));
        return;
      }

      if (!myAddress || peers.get(myAddress) !== ws) {
        send(ws, { type: 'error', reason: 'not_registered' });
        return;
      }

      if (msg.type === 'introduction') {
        if (!isValidAccountId(myAddress) || !isValidAccountId(msg.to) || msg.to === myAddress ||
            !validIntroductionFrame(msg)) { send(ws, { type: 'error', reason: 'invalid_introduction' }); return; }
        const target = peers.get(msg.to);
        if (!allowIntroduction() || target?.allowIntroductionReceive && !target.allowIntroductionReceive()) {
          send(ws, { type: 'introduction_unavailable', address: msg.to, reason: 'introduction_busy' }); return;
        }
        if (target?.readyState !== WebSocket.OPEN) {
          send(ws, { type: 'introduction_unavailable', address: msg.to, reason: 'peer_offline' }); return;
        }
        // Socket authentication fixes the sender. End-to-end signatures and
        // domain-separated encryption are verified by clients. No disk queue.
        send(target, { type: 'introduction', protocol: INTRODUCTION_PROTOCOL, from: myAddress,
          to: msg.to, kind: msg.kind, ...(msg.kind === 'frame' ? { frame: msg.frame } : {}) });
        return;
      }
      if (msg.type === 'watch_peer') {
        if (!isValidAddress(msg.to, allowDiagnosticPeers) || msg.to === myAddress) {
          send(ws, { type: 'error', reason: 'invalid_target' });
          return;
        }
        if (!watch(msg.to)) return;
        if (peers.get(msg.to)?.readyState === WebSocket.OPEN) {
          send(ws, { type: 'peer_online', address: msg.to });
        }
        return;
      }
      if (msg.type === 'unwatch_peer') {
        watchedAddresses.delete(msg.to); const listeners = watchers.get(msg.to); listeners?.delete(ws);
        if (listeners?.size === 0) watchers.delete(msg.to); return;
      }
      // Stateless transport of opaque, end-to-end authenticated courier packets.
      // No queue at the relay; authenticated socket identity supplies the hop.
      if (msg.type === 'courier_file_request' || msg.type === 'courier_file_chunk') {
        if (!isValidAccountId(myAddress) || !isValidAccountId(msg.to) || msg.to === myAddress ||
            (msg.type === 'courier_file_request' ? !validAttachmentRequest(msg.request) || msg.request.body.from !== myAddress || msg.request.body.to !== msg.to : !validAttachmentChunk(msg))) {
          send(ws, { type: 'error', reason: 'invalid_attachment_frame' }); return;
        }
        const target = peers.get(msg.to);
        if (target?.readyState === WebSocket.OPEN) send(target, { type: msg.type, from: myAddress, to: msg.to,
          ...(msg.type === 'courier_file_request' ? { request: msg.request } : { id: msg.id, index: msg.index, requestId: msg.requestId, cipher: msg.cipher }) });
        return;
      }
      if (msg.type === 'courier_delivery' || msg.type === 'courier_receipt') {
        if (!isValidAccountId(myAddress) || !isValidAccountId(msg.to) || msg.to === myAddress) {
          send(ws, { type: 'error', reason: 'invalid_courier_target' }); return;
        }
        if (msg.type === 'courier_delivery') {
          try { validateCourierJob(msg.job, myAddress); } catch { send(ws, { type: 'error', reason: 'invalid_courier_job' }); return; }
          if (msg.job.body.to !== msg.to || msg.hop?.body?.courier !== myAddress || msg.hop.body.id !== msg.job.body.id ||
              JSON.stringify(msg.hop).length > 2048) { send(ws, { type: 'error', reason: 'invalid_courier_hop' }); return; }
        } else if (typeof msg.id !== 'string' || !/^[a-f0-9]{32}$/.test(msg.id) || typeof msg.receipt !== 'string' || msg.receipt.length > 2048) {
          send(ws, { type: 'error', reason: 'invalid_courier_receipt' }); return;
        }
        const target = peers.get(msg.to);
        if (target?.readyState === WebSocket.OPEN) send(target, { type: msg.type, from: myAddress, to: msg.to,
          ...(msg.type === 'courier_delivery' ? { job: msg.job, hop: msg.hop } : { id: msg.id, receipt: msg.receipt }) });
        return;
      }

      if (msg.type === 'connect_request') {
        if (!isValidAddress(msg.to, allowDiagnosticPeers) || msg.to === myAddress) {
          send(ws, { type: 'error', reason: 'invalid_target' });
          return;
        }
        if (!watch(msg.to)) return;
        const target = peers.get(msg.to);
        if (target?.readyState === WebSocket.OPEN) {
          send(target, { type: 'connect_request', to: msg.to, from: myAddress });
        } else {
          send(ws, { type: 'peer_unavailable', address: msg.to, attemptId: '' });
        }
        return;
      }

      if (!['offer', 'answer', 'candidate'].includes(msg.type)) {
        send(ws, { type: 'error', reason: 'unknown_type' });
        return;
      }

      const legacyTest = myAddress.startsWith('peer-') &&
        typeof msg.to === 'string' &&
        msg.to.startsWith('peer-');
      const validAttempt = typeof msg.attemptId === 'string'
        ? msg.attemptId.length >= 8 && msg.attemptId.length <= 128
        : legacyTest && msg.attemptId === undefined;
      if (!isValidAddress(msg.to, allowDiagnosticPeers) || !validAttempt) {
        send(ws, { type: 'error', reason: 'invalid_target_or_attempt' });
        return;
      }

      if (msg.type === 'candidate') {
        const candidate = msg.candidate;
        if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 8192 ||
            (candidate.sdpMid != null && (typeof candidate.sdpMid !== 'string' || candidate.sdpMid.length > 256)) ||
            (candidate.sdpMLineIndex != null && (!Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0 || candidate.sdpMLineIndex > 65535)) ||
            (candidate.usernameFragment != null && (typeof candidate.usernameFragment !== 'string' || candidate.usernameFragment.length > 256))) {
          send(ws, { type: 'error', reason: 'invalid_candidate' });
          return;
        }
      } else if (!msg.sdp || typeof msg.sdp.sdp !== 'string' || msg.sdp.sdp.length > 48 * 1024 || msg.sdp.type !== msg.type) {
        send(ws, { type: 'error', reason: 'invalid_sdp' });
        return;
      }

      if (!watch(msg.to)) return;

      const target = peers.get(msg.to);
      if (!target || target.readyState !== WebSocket.OPEN) {
        send(ws, { type: 'peer_unavailable', address: msg.to, attemptId: msg.attemptId });
        return;
      }

      // The sender address comes from this socket, not from client JSON.
      send(target, { type: msg.type, to: msg.to, from: myAddress,
        ...(msg.attemptId !== undefined ? { attemptId: msg.attemptId } : {}),
        ...(msg.type === 'candidate' ? { candidate: {
          candidate: msg.candidate.candidate,
          sdpMid: msg.candidate.sdpMid ?? null,
          sdpMLineIndex: msg.candidate.sdpMLineIndex ?? null,
          ...(typeof msg.candidate.usernameFragment === 'string' ? { usernameFragment: msg.candidate.usernameFragment } : {}),
        } } : { sdp: { type: msg.sdp.type, sdp: msg.sdp.sdp } }),
      });
    }
    ws.on('message', (raw, binary) => {
      // No synchronous parser/validator exception may escape EventEmitter and
      // stop signaling for every other peer. Reject only the offending socket.
      try { handleMessage(raw, binary); }
      catch { ws.close(1008, 'invalid message'); }
    });

    ws.on('close', () => {
      registry.sockets.delete(ws);
      clearTimeout(registrationTimer);
      for (const address of watchedAddresses) {
        const listeners = watchers.get(address);
        listeners?.delete(ws);
        if (listeners?.size === 0) watchers.delete(address);
      }
      if (!myAddress || peers.get(myAddress) !== ws) return;
      peers.delete(myAddress);
      notifyWatchers(myAddress, 'peer_offline');

    });

    // Handle socket errors without retaining peer metadata or crashing Node.
    ws.on('error', () => {});

    ws.isAlive = () => alive;
    ws.markUnresponsive = () => { alive = false; };
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive?.()) {
        ws.terminate();
        continue;
      }
      ws.markUnresponsive();
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
