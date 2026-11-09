import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { Server as NetServer, Socket as NetSocket } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createSignalingServer, createSignalingRegistry } from './signaling.js';
import {RECIPIENT_INBOX_PATHS,validateRecipientGrant} from '../../protocol/src/recipient-inbox.js';
import {verifyCourierSignature} from './courier.js';
import { tokenBucket } from './limits.js';
import { isValidAccountId } from '../../protocol/src/bech32m.js';
import { NODE_PROTOCOL, MAILBOX_PROTOCOL } from '../../protocol/src/protocol.js';
import { NodeAuth, equalToken } from './auth.js';
import { NodeState } from './state.js';
import { DiskMailbox } from './mailbox.js';
import { Mailboxes } from './mailboxes.js';
import { Courier } from './courier.js';
import QRCode from 'qrcode';
import { attachmentLimits } from '../../protocol/src/attachment-protocol.js';
import { createAdminPanel } from './panel.js';
import { DeviceDirectory } from './devices.js';
import { DEVICE_DIRECTORY, DEVICE_PATHS } from '../../protocol/src/devices.js';
import { QUEUE_LIMIT_REASONS, textReserve } from './queue-quota.js';
import {CourierPrekeys} from './prekeys.js';
import {COURIER_PREKEY_PROTOCOL,COURIER_PREKEY_PATHS} from '../../protocol/src/courier-prekeys.js';

const BODY_LIMIT = 192 * 1024;
const queueCodes = new Set(['invalid_recipient_grant','invalid_envelope', 'invalid_ack', 'message_conflict', 'mailbox_full', 'courier_disabled', 'invalid_courier_job', 'invalid_courier_route', 'invalid_courier_author', 'invalid_courier_signature', 'invalid_attachment', 'invalid_attachment_part', 'attachment_conflict', 'attachment_incomplete', 'attachment_denied', 'attachment_digest_mismatch']);
const deniedCodes = new Set(['unauthorized', 'not_owner', 'not_member', 'sender_not_allowed', 'invalid_pair_code', 'already_paired', 'member_removal_pending']);
// Hosting may decorate HTTP Server.address / Socket.remoteAddress with proxy
// metadata. Local management must use the underlying net listener/peer instead.
const listenerAddress = server => NetServer.prototype.address.call(server);
const peerAddress = socket => Object.getOwnPropertyDescriptor(NetSocket.prototype, 'remoteAddress').get.call(socket);

// HTTP is a loopback-only test option, never a LAN fallback. The separate
// control listener is loopback only and rejects browser Origin headers.
export async function createHomeNode({ directory, tls, origins, hosts, adminToken,
  maxBytes = 64 * 1024 * 1024, maxMessages = 1000, maxFiles, maxFilesPerProfile, now = Date.now, testHttp = false, unixProxy = false, unixListenerProof, onShutdown, courierRelay = '', testRelay = false, secretProtector, signalingEnabled = true, lanCa, localRouteScope = 'lan', localSignalServername, panelConfig }) {
  if (!['lan', 'internet'].includes(localRouteScope)) throw new Error('invalid_route_scope');
  // Production HTTP is permitted ONLY on a Unix socket behind a TLS-terminating
  // hosting frontend. It cannot become a plaintext TCP/LAN fallback. The adapter
  // must enforce HTTPS before forwarding and keep its socket private.
  if (unixProxy && (tls || testHttp || process.platform !== 'linux' || localRouteScope !== 'internet')) throw new Error('invalid_proxy_transport');
  if (unixListenerProof !== undefined && (!unixProxy || typeof unixListenerProof !== 'function')) throw new Error('invalid_proxy_transport');
  if (!tls && !testHttp && !unixProxy) throw new Error('tls_required');
  if (!Array.isArray(origins) || !origins.length || origins.some(origin => new URL(origin).origin !== origin ||
      !['https:', 'http:'].includes(new URL(origin).protocol) || (new URL(origin).protocol === 'http:' &&
      !['localhost', '127.0.0.1'].includes(new URL(origin).hostname)))) throw new Error('invalid_node_origins');
  if (!Array.isArray(hosts) || !hosts.length || hosts.some(host => typeof host !== 'string' || host.length > 255) ||
      typeof adminToken !== 'string' || !/^[a-f0-9]{64}$/.test(adminToken)) throw new Error('invalid_node_configuration');
  const state = await new NodeState(directory).initialize();
  if (panelConfig && localRouteScope !== 'internet') throw new Error('invalid_panel_role');
  const panel = panelConfig ? await createAdminPanel({ ...panelConfig, directory, protector: secretProtector, now, mustExist: state.value.panelInitialized === true }) : null;
  if (panel && !state.value.panelInitialized) await state.change(next => { next.panelInitialized = true; });
  let operationChain = Promise.resolve();
  const serialize = work => {
    const result = operationChain.then(work); operationChain = result.catch(() => {}); return result;
  };
  const mailbox = await new DiskMailbox(join(directory, 'mailbox'), { maxBytes, maxMessages, now }).initialize();
  const mailboxes = await new Mailboxes(directory, mailbox, state, { maxBytes, maxMessages, now }).initialize();
  const courier = await new Courier(directory, { maxBytes, maxMessages, maxFiles, maxFilesPerProfile, relay: courierRelay, testRelay, secretProtector, lanEnabled: signalingEnabled && localRouteScope === 'lan', localInternetEnabled: signalingEnabled && localRouteScope === 'internet',
    serialize, authorize: address => !state.failed && state.value.members.some(member => member.address === address) }).initialize();
  const prekeys=await new CourierPrekeys(join(directory,'courier-prekeys'),{nodeId:state.value.nodeId,now,
    maxBytes:Math.min(8*1024*1024,Math.floor(maxBytes/8)),isMember:address=>!state.failed&&state.value.members.some(m=>m.address===address)}).initialize();
  const devices = await new DeviceDirectory(directory, { maxBytes, maxMessages, now, nodeId: state.value.nodeId, publicKey: courier.publicKey,
    isOwner: owner => state.value.members.some(m => m.address === owner),
    allowed: (recipient, sender) => recipient === sender || state.value.members.some(m => m.address === recipient && m.senders.includes(sender)),
    grant: async (owner, sender, revoke) => state.change(next => {
      const member = next.members.find(m => m.address === owner);
      if (!member) throw new Error('not_member');
      if (revoke) member.senders = member.senders.filter(id => id !== sender);
      else if (!member.senders.includes(sender)) {
        if (member.senders.length >= 50) throw new Error('sender_limit'); member.senders.push(sender);
      }
      if (next.owner?.address === owner) next.senders = [...member.senders];
    }),
    sign: (purpose, body) => courier.sign(purpose, body), availableBytes: () => maxBytes - totalStats().bytes }).initialize();
  const finishRemoval = async address => {
    await prekeys.removeOwner(address);
    await devices.removeOwner(address);
    await courier.removeMember(address); await mailboxes.remove(address);
    await state.change(next => { next.pendingRemovals = next.pendingRemovals.filter(item => item !== address); });
  };
  // Access is revoked durably BEFORE deletion. Finish interrupted cleanup before
  // opening any listener or route; re-pairing cannot resurrect old queued data.
  for (const address of [...state.value.pendingRemovals]) await finishRemoval(address);
  const totalStats = () => ({ ...mailboxes.stats(), messages: mailboxes.stats().messages + courier.box.stats().messages + devices.stats().messages,
    bytes: mailboxes.stats().bytes + courier.box.stats().bytes + courier.attachments.stats().bytes + devices.stats().bytes + prekeys.stats().bytes });
  if (totalStats().bytes > maxBytes) { await courier.close(); throw new Error('mailbox_disk_limit'); }
  courier.start();
  const auth = new NodeAuth(state.value.nodeId, now, panel ? ['/admin/connect/approve'] : []);
  const registry = createSignalingRegistry();
  const publicServers = [], signalingServers = [];
  let pairCode = randomBytes(16).toString('hex'), pairExpires = now() + 10 * 60_000;
  const allowRequest = tokenBucket(30, 60, now);
  const allowBytes = tokenBucket(256 * 1024, 512 * 1024, now);
  const allowFileBytes = tokenBucket(2 * 1024 * 1024, 4 * 1024 * 1024, now);
  const hostAllowed = request => hosts.includes(request.headers.host);
  let closing = false;
  const json = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    response.end(JSON.stringify(body));
  };
  const memberCheck = identity => {
    const member = state.value.members.find(item => item.address === identity.address && item.publicKey === identity.publicKey);
    if (!member) throw new Error('not_member'); return member;
  };
  const statusValue = () => ({ protocol: NODE_PROTOCOL, nodeId: state.value.nodeId, owner: state.value.owner?.address ?? null,
    ...totalStats(), maxBytes, maxMessages, courier: courier.stats(), textReservedBytes: textReserve(maxBytes), protection: secretProtector.protection, internetIncoming: false,
    signaling: { enabled: signalingEnabled, clients: [...registry.peers.keys()].filter(address => address !== courier.address).length, maxConnections: 128 },
    memberManagement: true, members: state.value.members.map(member => ({ address: member.address, messages: 0, bytes: 0, maxBytes,
      ...mailboxes.boxes.get(member.address)?.stats(), ...(member.address === state.value.primaryAddress ? mailbox.stats() : {}), senders: member.senders.length,
      outgoing: courier.stats(member.address).messages, files: courier.stats(member.address).attachments.files,
      filesLimit: courier.attachments.maxFilesPerProfile, uploadingFiles: courier.stats(member.address).attachments.uploading,
      queueBytes: (mailboxes.boxes.get(member.address) ?? (member.address === state.value.primaryAddress ? mailbox : null))?.stats().bytes ?? 0,
      outgoingBytes: courier.stats(member.address).bytes, fileReservedBytes: courier.stats(member.address).attachments.bytes })), memberLimit: 8 });
  const invite = () => { pairCode = randomBytes(16).toString('hex'); pairExpires = now() + 600000; return { pairCode, pairExpires }; };
  const removeMember = address => serialize(async () => {
    if (closing || state.failed) throw new Error('node_unavailable');
    if (state.value.members.some(member => member.address === address)) {
      await state.change(next => {
        next.members = next.members.filter(member => member.address !== address);
        for (const member of next.members) member.senders = member.senders.filter(id => id !== address);
        const first = next.members.find(member => member.address === next.owner?.address) ?? next.members[0];
        next.owner = first ? { address: first.address, publicKey: first.publicKey } : null;
        next.senders = first ? [...first.senders] : []; next.pendingRemovals.push(address);
      });
    }
    if (state.value.pendingRemovals.includes(address)) await finishRemoval(address);
    pairCode = ''; pairExpires = 0;
    return { removed: true, address, members: state.value.members.length, memberLimit: 8 };
  });
  async function handlePublic(request, response) {
    try {
      if (closing || state.failed) { json(response, 503, { error: 'node_unavailable' }); return; }
      if (!hostAllowed(request)) { json(response, 403, { error: 'invalid_host' }); return; }
      const origin = request.headers.origin;
      if (origin && !origins.includes(origin)) { json(response, 403, { error: 'origin_denied' }); return; }
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        // WebKit may include cache headers in the preflight for fetch(no-store).
        // Keep an explicit list and the exact approved Origin, never a wildcard.
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Automesh-Proof, Cache-Control, Pragma, Accept, Accept-Language, Content-Language');
      }
      if (!allowRequest()) { json(response, 429, { error: 'rate_limit' }); return; }
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      if (panel && await panel.handle(request, response, { nodeId: state.value.nodeId, status: statusValue, invite: () => serialize(invite), remove: removeMember })) return;
      if (request.method === 'GET' && request.url === '/node/info') {
        json(response, 200, { protocol: NODE_PROTOCOL, nodeId: state.value.nodeId, role: localRouteScope === 'internet' ? 'server' : 'home',
          capabilities: signalingEnabled ? ['signaling', 'opaque-mailbox', 'device-directory-v2'] : ['opaque-mailbox', 'device-directory-v2'], mailboxProtocol: MAILBOX_PROTOCOL,
          deviceDirectory: { protocol: DEVICE_DIRECTORY, publicKey: courier.publicKey },
          paired: Boolean(state.value.owner), chatOfflineDelivery: true, multiMailbox: true, ...(panel ? { adminPanel: true } : {}),
          courierProtocol: 'automesh-courier-v1', courierAddress: courier.address, courierEnabled: courier.enabled, signalingEnabled,
          courierLanEnabled: courier.lanEnabled, courierInternetEnabled: courier.localInternetEnabled || Boolean(courierRelay), deliveryScopes: true, fileQueue: attachmentLimits() }); return;
      }
      if (request.method !== 'POST' || !['/node/challenge', '/node/pair', '/node/join', '/mailbox/put', '/mailbox/list', '/mailbox/receipts',
        '/mailbox/ack', '/mailbox/grant', '/mailbox/revoke', '/mailbox/status', '/outbox/put', '/outbox/status', '/outbox/list', '/outbox/receipts', '/outbox/outcomes', '/outbox/cancel', '/outbox/route', '/outbox/file/start', '/outbox/file/part', '/outbox/file/cancel',
          '/inbox/list', '/inbox/ack', '/inbox/file/parts', ...RECIPIENT_INBOX_PATHS, ...COURIER_PREKEY_PATHS, ...DEVICE_PATHS, ...(panel ? ['/admin/connect/approve'] : [])].includes(request.url)) {
        json(response, 404, { error: 'not_found' }); return;
      }
      if (request.headers['content-type'] !== 'application/json') { json(response, 415, { error: 'json_required' }); return; }
      const bytes = await readBody(request, request.url === '/outbox/file/part' ? allowFileBytes : allowBytes); const body = JSON.parse(bytes.toString('utf8'));
      if (request.url === '/node/challenge') { json(response, 200, auth.issue(body)); return; }
      const proofHeader = request.headers['x-automesh-proof'];
      if (typeof proofHeader !== 'string' || proofHeader.length > 2048) throw new Error('unauthorized');
      let proof;
      try { proof = JSON.parse(Buffer.from(proofHeader, 'base64url').toString('utf8')); }
      catch { throw new Error('unauthorized'); }
      const identity = await auth.verify(proof, request.method, request.url, bytes);
      const result = await serialize(async () => {
        if (closing || state.failed) throw new Error('node_unavailable');
        if (DEVICE_PATHS.includes(request.url)) return devices.handle(request.url, identity, body);
        if (panel && request.url === '/admin/connect/approve') return panel.approve(identity, body, state.value.nodeId);
        if(request.url.startsWith('/prekeys/')){
          if(request.url==='/prekeys/availability')return prekeys.availability(identity.address,body);
          if(request.url==='/prekeys/allocate')return prekeys.allocate(identity.address,body);
          memberCheck(identity);
          if(request.url==='/prekeys/revoke')return prekeys.revoke(identity.address,body.peer);
          const limit=prekeys.maxBytes;
          prekeys.maxBytes=Math.min(limit,Math.max(0,maxBytes-totalStats().bytes+prekeys.stats().bytes));
          try{return request.url==='/prekeys/status'?await prekeys.status(identity.address,body.peer):await prekeys.publish(identity.address,body);}finally{prekeys.maxBytes=limit;}
        }
        if(RECIPIENT_INBOX_PATHS.includes(request.url)){
          const grant=validateRecipientGrant(body.grant,courier.address,state.value.nodeId,identity.address);
          if(!courier.authorize(grant.body.from))throw Error('sender_not_allowed');
          await verifyCourierSignature(grant,'recipient-inbox',grant.body.from);
          if(request.url==='/receive/list')return courier.inbox(identity.address,{cursor:body.cursor},localRouteScope,grant.body.from);
          if(request.url==='/receive/file/parts')return courier.inboxParts(identity.address,{request:body.request},localRouteScope,grant.body.from);
          return courier.acknowledgeInbox(identity.address,{id:body.id,receipt:body.receipt},grant.body.from);
        }
        if (request.url.startsWith('/inbox/')) {
          memberCheck(identity);
          if (request.url === '/inbox/list') return courier.inbox(identity.address, body, localRouteScope);
          if (request.url === '/inbox/file/parts') return courier.inboxParts(identity.address, body, localRouteScope);
          return courier.acknowledgeInbox(identity.address, body);
        }
        if (request.url.startsWith('/outbox/')) {
          memberCheck(identity);
          if (request.url === '/outbox/route') return courier.rememberRoute(identity.address,body.route);
          if (request.url === '/outbox/status') return {...courier.stats(identity.address),prekeyProtocol:COURIER_PREKEY_PROTOCOL,prekeyPeers:prekeys.summary(identity.address),
            quota:{protocol:'automesh-queue-quota-v1',profileFiles:courier.stats(identity.address).attachments.files,profileFileLimit:courier.attachments.maxFilesPerProfile,
              ...courier.box.quota(identity.address),
              nodeFiles:courier.attachments.stats().files,nodeFileLimit:courier.attachments.maxFiles,reservedBytes:totalStats().bytes,maxBytes}};
          if (request.url === '/outbox/list') return courier.outbox(identity.address,body);
          if (request.url === '/outbox/receipts') return { receipts: await courier.box.receipts(identity.address, body.ids) };
          if (request.url === '/outbox/outcomes') return { outcomes: await courier.box.outcomes(identity.address, body.ids), checkedAt: Date.now() };
          if (request.url === '/outbox/cancel') return courier.cancel(identity.address, body.job);
          if (request.url === '/outbox/file/start') {
            courier.attachments.maxBytes = Math.max(0, maxBytes - mailboxes.stats().bytes - courier.box.stats().bytes - devices.stats().bytes - prekeys.stats().bytes - textReserve(maxBytes));
            try { return await courier.startFile(identity.address, body.job); } finally { courier.attachments.maxBytes = maxBytes; }
          }
          if (request.url === '/outbox/file/part') return courier.attachments.put(identity.address, body.id, body.index, body.cipher);
          if (request.url === '/outbox/file/cancel') return courier.cancelFile(identity.address, body.job);
          courier.box.maxBytes = Math.max(0, maxBytes - mailboxes.stats().bytes - courier.attachments.stats().bytes - devices.stats().bytes - prekeys.stats().bytes);
          try { return await courier.put(identity.address, body.job); }
          finally { courier.box.maxBytes = maxBytes; }
        }
        if (request.url === '/node/pair' || request.url === '/node/join') {
          const existing = state.value.members.find(item => item.address === identity.address);
          if (request.url === '/node/join' && existing?.publicKey === identity.publicKey) return { nodeId: state.value.nodeId, paired: true };
          if (request.url === '/node/pair' && state.value.owner) throw new Error('already_paired');
          if (state.value.pendingRemovals.includes(identity.address)) throw new Error('member_removal_pending');
          if (now() >= pairExpires || !equalToken(body.code, pairCode)) throw new Error('invalid_pair_code');
          if (state.value.members.length >= 8) throw new Error('member_limit');
          await state.change(next => {
            if (!next.owner) next.owner = identity;
            if (!next.primaryAddress) next.primaryAddress = identity.address;
            next.members.push({ ...identity, senders: [] });
          }); pairCode = ''; pairExpires = 0;
          return { nodeId: state.value.nodeId, owner: identity.address, paired: true };
        }
        if (request.url === '/mailbox/put') {
          const recipient = body.recipient ?? state.value.owner?.address;
          const member = state.value.members.find(item => item.address === recipient);
          if (!member || (identity.address !== member.address && !member.senders.includes(identity.address))) throw new Error('sender_not_allowed');
          const box = await mailboxes.get(recipient);
          box.maxBytes = Math.max(0, maxBytes - totalStats().bytes + box.stats().bytes);
          try { return await box.put(identity.address, body); }
          finally { box.maxBytes = maxBytes; }
        }
        if (request.url === '/mailbox/receipts') {
          const recipient = body.recipient;
          const member = state.value.members.find(item => item.address === recipient);
          if (!member || (identity.address !== recipient && !member.senders.includes(identity.address))) throw new Error('sender_not_allowed');
          return { receipts: await (await mailboxes.get(recipient)).receipts(identity.address, body.ids) };
        }
        const member = memberCheck(identity); const box = await mailboxes.get(identity.address);
        if (request.url === '/mailbox/list') return { envelopes: await box.list() };
        if (request.url === '/mailbox/ack') return box.acknowledge(body.ids, body.receipts);
        if (request.url === '/mailbox/status') return { ...box.stats(), senders: member.senders };
        if (!isValidAccountId(body.address)) throw new Error('invalid_sender');
        await state.change(next => {
          const target = next.members.find(item => item.address === identity.address);
          if (request.url === '/mailbox/revoke') target.senders = target.senders.filter(id => id !== body.address);
          else if (!target.senders.includes(body.address)) {
            if (target.senders.length >= 50) throw new Error('sender_limit'); target.senders.push(body.address);
          }
          if (identity.address === next.owner.address) next.senders = [...target.senders];
        });
        return { allowed: request.url === '/mailbox/grant', address: body.address };
      });
      json(response, 200, result);
    } catch (error) {
      const code = error.message;
      const safe = queueCodes.has(code) || deniedCodes.has(code) || ['device_denied', 'device_capacity', 'device_policy_conflict', 'device_keys_unavailable',
        'invalid_device_signature', 'invalid_device_roster', 'invalid_device_authority', 'invalid_device_object',
        'prekey_denied','prekey_capacity','prekeys_unavailable','invalid_prekey','invalid_prekey_lifetime','invalid_prekey_source','invalid_prekey_request','prekey_conflict',
        'invalid_challenge', 'too_many_challenges', 'invalid_sender', 'sender_limit', 'member_limit', 'body_limit', 'rate_limit'].includes(code);
      json(response, deniedCodes.has(code) ? 403 : queueCodes.has(code) || safe ? 400 : error instanceof SyntaxError ? 400 : 503,
        { error: safe ? code : error instanceof SyntaxError ? 'invalid_json' : 'node_unavailable',
          ...(code === 'mailbox_full' && QUEUE_LIMIT_REASONS.has(error.limit) ? { limit: error.limit } : {}) });
    }
  }
  function createPublicServer() {
    // LiteSpeed annotates the proxied socket with the original client's address.
    // Trust the actual listener (Unix vs TCP), NOT remoteAddress or forwarded
    // headers. A Unix-bound server cannot directly accept an Internet TCP peer.
    const transportAllowed = () => !unixProxy || typeof listenerAddress(server) === 'string' || unixListenerProof?.(server) === true;
    const handler = (request, response) => {
      if (!transportAllowed(request)) { json(response, 403, { error: 'transport_denied' }); return; }
      return handlePublic(request, response);
    };
    const server = tls ? createHttpsServer({ ...tls, maxHeaderSize: 4096 }, handler) : createHttpServer({ maxHeaderSize: 4096 }, handler);
    server.maxConnections = 128; server.requestTimeout = 10_000; server.headersTimeout = 5000; server.keepAliveTimeout = 2000;
    const signaling = signalingEnabled ? createSignalingServer({ httpServer: server, path: '/signal', registry,
      allowedOrigins: origins, iceMode: localRouteScope === 'lan' ? 'lan' : undefined, maxConnections: 128 }) : null;
    // ws forwards HTTP bind errors onto its own EventEmitter first. Handle that
    // duplicate so the runner's HTTP listen promise can reject and clean up.
    // Otherwise EADDRINUSE becomes an uncaught WSS error and strands the lock.
    if (signaling) signaling.on('error', () => {});
    // Reject DNS rebinding / wrong Host even for WebSocket upgrades.
    server.prependListener('upgrade', (request, socket) => { if (!transportAllowed(request) || !signalingEnabled || !hostAllowed(request)) socket.destroy(); });
    server.once('listening', () => {
      const address = listenerAddress(server);
      // The courier joins the same registry as LAN clients, using a signed
      // registration and verified TLS. Never open another public listener.
      if (!unixProxy && signaling && address?.address === '127.0.0.1') {
        const url = `${tls ? 'wss' : 'ws'}://127.0.0.1:${address.port}/signal`;
        if (localRouteScope === 'internet') courier.attachLocalInternet(url, lanCa, localSignalServername);
        else courier.attachLan(url, lanCa);
      }
    });
    publicServers.push(server); if (signaling) signalingServers.push(signaling); return server;
  }
  const control = createHttpServer({ maxHeaderSize: 1024 }, async (request, response) => {
    if (closing || state.failed) { json(response, 503, { error: 'node_unavailable' }); return; }
    if (!['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(peerAddress(request.socket)) || request.headers.origin ||
        request.headers.host !== `127.0.0.1:${listenerAddress(control)?.port}` ||
        !equalToken(request.headers.authorization, `Bearer ${adminToken}`)) { json(response, 403, { error: 'control_denied' }); return; }
    if (request.method === 'GET' && request.url === '/status') {
      json(response, 200, { ...statusValue(), pairCode, pairExpires }); return;
    }
    if (request.method === 'POST' && request.url === '/admin-setup' && panel) {
      try { json(response, 200, panel.setup()); } catch { json(response, 409, { error: 'panel_setup_denied' }); } return;
    }
    if (request.method === 'POST' && request.url === '/members/remove') {
      try {
        if (request.headers['content-type'] !== 'application/json') { json(response, 415, { error: 'json_required' }); return; }
        const body = JSON.parse((await readBody(request, () => true, 2048)).toString('utf8'));
        if (!isValidAccountId(body?.address) || body.confirm !== 'remove-node-data' || Object.keys(body).sort().join(',') !== 'address,confirm') {
          json(response, 400, { error: 'invalid_member_removal' }); return;
        }
        const result = await removeMember(body.address);
        json(response, 200, result);
      } catch (error) { json(response, error instanceof SyntaxError ? 400 : 503,
        { error: error instanceof SyntaxError ? 'invalid_json' : 'member_removal_incomplete' }); }
      return;
    }
    if (request.method === 'GET' && ['/qr/signal', '/qr/pair', '/qr/pair-local'].includes(request.url)) {
      const host = request.url === '/qr/pair-local' ? hosts.find(host => host.startsWith('localhost:'))
        : hosts.find(host => !host.startsWith('127.0.0.1:') && !host.startsWith('localhost:'));
      if (!host || (request.url === '/qr/signal' && !signalingEnabled)) { json(response, 409, { error: 'node_not_ready' }); return; }
      const value = request.url === '/qr/signal' ? `wss://${host}/signal`
        : JSON.stringify({ protocol: 'automesh-node-pair-v1', url: `https://${host}/`, nodeId: state.value.nodeId, code: pairCode, expiresAt: pairExpires });
      if (request.url !== '/qr/signal' && (!pairCode || pairExpires <= now())) { json(response, 409, { error: 'pair_code_expired' }); return; }
      const image = await QRCode.toBuffer(value, { width: 340, margin: 4, errorCorrectionLevel: 'M' });
      response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(image); return;
    }
    if (request.method === 'POST' && request.url === '/pair-code') {
      json(response, 200, await serialize(invite)); return;
    }
    if (request.method === 'POST' && request.url === '/shutdown' && onShutdown) {
      json(response, 200, { stopping: true }); setImmediate(onShutdown); return;
    }
    json(response, 404, { error: 'not_found' });
  });
  control.maxConnections = 8; control.headersTimeout = 5000; control.requestTimeout = 5000;
  const sweep = setInterval(() => { for (const box of mailboxes.all()) void box.serialized(() => box.sweep()).catch(() => {});
    if(!closing)void serialize(()=>prekeys.sweep()).catch(()=>{}); }, 60_000); sweep.unref();
  return { createPublicServer, control, state, mailbox, mailboxes, courier, devices, prekeys,
    async close() {
      if (closing) return;
      closing = true; clearInterval(sweep); panel?.close();
      courier.active = false;
      await operationChain;
      await courier.close();
      for (const signaling of signalingServers) {
        for (const socket of signaling.clients) socket.terminate();
        await new Promise(resolve => signaling.close(resolve));
      }
      for (const server of [...publicServers, control]) {
        server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
      }
      await operationChain; for (const box of mailboxes.all()) await box.chain; await state.chain;
    } };
}
async function readBody(request, allowBytes, limit = BODY_LIMIT) {
  if (request.headers['content-length'] && Number(request.headers['content-length']) > limit) throw new Error('body_limit');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('body_limit');
    if (!allowBytes(chunk.length)) throw new Error('rate_limit'); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
