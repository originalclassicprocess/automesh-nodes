import { webcrypto, createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { accountIdFromPublicKey } from '../../protocol/src/account-id.js';
import { isValidAccountId } from '../../protocol/src/bech32m.js';
import { registrationProofBytes } from '../../protocol/src/registration-proof.js';
import { courierBytes, COURIER_PROTOCOL, validateCourierJob, courierRelayUrl } from '../../protocol/src/courier-protocol.js';
import { MAILBOX_PROTOCOL } from '../../protocol/src/protocol.js';
import { writeAtomic } from './files.js';
import { DiskMailbox } from './mailbox.js';
import { DiskAttachments } from './attachments.js';
import { attachmentLimits, validAttachmentRequest } from '../../protocol/src/attachment-protocol.js';
import { COURIER_PURPOSE, openSecret, sealSecret } from './secrets.js';
import { COURIER_ROUTE_PROTOCOL, COURIER_ROUTE_TTL, MAX_DISCOVERED_ROUTES, validateCourierRoute } from '../../protocol/src/courier-route.js';
import { publicLookup } from './public-lookup.js';
const hex = value => Buffer.from(value).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
export async function verifyCourierSignature(value, purpose, address) {
  if (!value || !/^04[a-f0-9]{128}$/.test(value.publicKey) || !/^[a-f0-9]{128}$/.test(value.signature)) throw new Error('invalid_courier_signature');
  const bytes = Buffer.from(value.publicKey, 'hex');
  if (await accountIdFromPublicKey(bytes, webcrypto.subtle) !== address) throw new Error('invalid_courier_signature');
  const key = await webcrypto.subtle.importKey('raw', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(value.signature, 'hex'), courierBytes(purpose, value.body)))
    throw new Error('invalid_courier_signature');
}
// Separate node key; never derived from a member's mnemonic or identity key.
export class Courier {
  constructor(directory, { maxBytes, maxMessages = 1000, maxFiles, maxFilesPerProfile, relay = '', testRelay = false, secretProtector, lanEnabled = false, localInternetEnabled = false, serialize, authorize = () => true } = {}) {
    if (!secretProtector || typeof secretProtector.protect !== 'function' || typeof secretProtector.unprotect !== 'function') throw new Error('node_secret_protection_unavailable');
    this.secretProtector = secretProtector;
    this.directory = directory; this.maxBytes = maxBytes; this.maxMessages = maxMessages; this.fileOptions = { maxFiles, maxFilesPerProfile }; this.relay = relay ? courierRelayUrl(relay, testRelay) : '';
    this.active = true; this.lanEnabled = lanEnabled; this.localInternetEnabled = localInternetEnabled; this.routes = new Map();
    this.learnedRoutes = new Map();
    this.chain = Promise.resolve(); this.queued = 0;
    this.serialize = serialize ?? (work => this.chain.then(work)); this.authorize = authorize;
    if (this.relay) this.addRoute('internet', this.relay);
  }
  get enabled() { return this.lanEnabled || this.localInternetEnabled || Boolean(this.relay); }
  get ready() { return [...this.routes.values()].some(route => route.ready); }
  get status() { return this.ready ? 'connected' : [...this.routes.values()].some(route => route.status === 'relay_outdated') ? 'relay_outdated' : this.enabled ? 'connecting' : 'disabled'; }
  createSocket(url, options) { return new WebSocket(url, options); }
  addRoute(name, url, ca, servername, host, discovered) {
    if (this.routes.has(name)) return;
    const route = { name, url, ca, servername, host, discovered, ready: false, status: 'connecting', watched: new Set(), online: new Set(), lastSent: new Map(), attempt: 0 };
    this.routes.set(name, route);
    if (this.started) this.connect(route);
  }
  attachLan(url, ca) { if (this.lanEnabled) this.addRoute('lan', url, ca); }
  attachLocalInternet(url, ca, servername) { if (this.localInternetEnabled) this.addRoute('local-internet', url, ca, servername); }
  attachLocalInternetUnix(path, host) {
    if (process.platform !== 'linux' || typeof path !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(path) || path.length > 100 ||
        typeof host !== 'string' || !/^[a-z0-9.-]+(?::[0-9]+)?$/.test(host)) throw new Error('invalid_courier_socket');
    if (this.localInternetEnabled) this.addRoute('local-internet', `ws+unix://${path}:/signal`, undefined, undefined, host);
  }
  async initialize() {
    const path = join(this.directory, 'courier-key.json'); let saved;
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('corrupt_courier_key');
      saved = JSON.parse(await readFile(path, 'utf8'));
      if (saved.protection) saved = await openSecret(saved, COURIER_PURPOSE, this.secretProtector);
    } catch (error) { if (error.code !== 'ENOENT') throw error;
      const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      saved = { publicKey: hex(await webcrypto.subtle.exportKey('raw', pair.publicKey)),
        privateKey: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64') };
    }
    if (!/^04[a-f0-9]{128}$/.test(saved.publicKey) || typeof saved.privateKey !== 'string' || saved.privateKey.length > 1024) throw new Error('corrupt_courier_key');
    this.publicKey = saved.publicKey;
    this.address = await accountIdFromPublicKey(Buffer.from(saved.publicKey, 'hex'), webcrypto.subtle);
    this.privateKey = await webcrypto.subtle.importKey('pkcs8', Buffer.from(saved.privateKey, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const proof = await this.sign('key-check', {}); await verifyCourierSignature(proof, 'key-check', this.address);
    const protectedKey = await sealSecret(saved, COURIER_PURPOSE, this.secretProtector);
    await openSecret(protectedKey, COURIER_PURPOSE, this.secretProtector);
    await writeAtomic(this.directory, 'courier-key.json', protectedKey);
    try {
      const routePath = join(this.directory,'courier-routes.json'), info = await lstat(routePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024*1024) throw new Error('corrupt_courier_routes');
      const saved = JSON.parse(await readFile(routePath,'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.routes) || saved.routes.length > 400) throw new Error('corrupt_courier_routes');
      for (const route of saved.routes) {
        const b = route?.body;
        validateCourierRoute(route,b?.from,b?.to,b?.issuedAt);
        await verifyCourierSignature(route,'route',b.from);
        if (this.authorize(b.to) && b.issuedAt + COURIER_ROUTE_TTL + 300000 > Date.now()) {
          const key = this.routeKey(b.to,b.from), old = this.learnedRoutes.get(key);
          if (old && old.body.issuedAt >= b.issuedAt) throw new Error('corrupt_courier_routes');
          this.learnedRoutes.set(key,route);
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.box = await new DiskMailbox(join(this.directory, 'outbox'), { maxBytes: this.maxBytes, maxMessages: this.maxMessages, retainOutcomes: true }).initialize();
    this.attachments = await new DiskAttachments(join(this.directory, 'attachments'), this.maxBytes, this.fileOptions).initialize();
    for (const [id, r] of this.attachments.records) {
      validateCourierJob(r.job, this.address); await verifyCourierSignature(r.job, 'job', r.job.body.from);
      if (['acknowledged','canceled','expired'].includes(this.box.records.get(r.job.body.id.replaceAll('-', ''))?.status)) await this.attachments.remove(id);
    }
    // Validate persisted jobs before any connection, never send damaged records.
    for (const record of this.box.records.values()) if (record.status === 'stored') {
      const job = this.decode(record); validateCourierJob(job, this.address); await verifyCourierSignature(job, 'job', record.sender);
      await this.verifyRoute(job);
      if (job.body.from !== record.sender || job.body.id.replaceAll('-', '') !== record.id || job.body.expiresAt !== record.expiresAt) throw new Error('corrupt_courier_queue');
    }
    return this;
  }
  decode(record) { return JSON.parse(Buffer.from(record.ciphertext, 'base64url').toString('utf8')); }
  async verifyRoute(job) {
    if (!job.body.route) return;
    validateCourierRoute(job.body.route, job.body.to, job.body.from);
    await verifyCourierSignature(job.body.route, 'route', job.body.to);
  }
  routeKey(sender,recipient) { return `${sender}:${recipient}`; }
  async rememberRoute(sender,route) {
    validateCourierRoute(route,route?.body?.from,sender);
    await verifyCourierSignature(route,'route',route.body.from);
    if (!this.authorize(sender)) throw new Error('not_member');
    const key = this.routeKey(sender,route.body.from), old = this.learnedRoutes.get(key);
    if (old && old.body.issuedAt >= route.body.issuedAt) {
      if (old.body.issuedAt === route.body.issuedAt && JSON.stringify(old.body) !== JSON.stringify(route.body)) throw new Error('invalid_courier_route');
      return { protocol: COURIER_ROUTE_PROTOCOL, accepted: false };
    }
    const next = new Map([...this.learnedRoutes].filter(([,r]) => this.authorize(r.body.to) && r.body.issuedAt + COURIER_ROUTE_TTL + 300000 > Date.now()));
    if (!next.has(key) && (next.size >= 400 || [...next.values()].filter(r => r.body.to === sender).length >= 50))
      return { protocol: COURIER_ROUTE_PROTOCOL, accepted: false };
    next.set(key,route);
    await writeAtomic(this.directory,'courier-routes.json',{version:1,routes:[...next.values()]});
    this.learnedRoutes = next;
    this.enqueue(() => this.flush());
    return { protocol: COURIER_ROUTE_PROTOCOL, accepted: true };
  }
  routeFor(job) {
    if (job.body.lanOnly || job.body.attachment) return null;
    const known = this.learnedRoutes.get(this.routeKey(job.body.from,job.body.to));
    const original = job.body.route;
    const route = known && (!original || known.body.issuedAt >= original.body.issuedAt) ? known : original;
    // Keep the high-water mark after expiry; never fall back to an older route.
    return route?.body.expiresAt > Date.now() ? route : null;
  }
  syncDiscovered(records) {
    const candidates = new Map();
    for (const record of records) {
      const job = this.decode(record), b = this.routeFor(job)?.body;
      if (!b || job.body.lanOnly || job.body.attachment || b.expiresAt <= Date.now() || b.nodeAddress === this.address ||
          [...this.routes.values()].some(r => !r.discovered && r.url === b.signalingUrl)) continue;
      const key = `discovered:${b.signalingUrl}`;
      candidates.set(key, b);
    }
    const entries = [...candidates.entries()].sort(([a],[b]) => a.localeCompare(b));
    // Rotate a bounded window for large queues; offline first contacts cannot
    // monopolize the entire socket budget. No wildcard discovery or subnet scans.
    const offset = entries.length > MAX_DISCOVERED_ROUTES ? Math.floor(Date.now()/60000) % entries.length : 0;
    const selected = new Map([...entries.slice(offset),...entries.slice(0,offset)].slice(0,MAX_DISCOVERED_ROUTES));
    for (const [name,route] of this.routes) if (route.discovered && !selected.has(name)) {
      this.routes.delete(name); clearTimeout(route.reconnect);
      const socket = route.ws; route.ws = null; socket?.terminate();
    }
    for (const [name,b] of selected) if (!this.routes.has(name)) {
      // Mark before connecting so the first DNS lookup is guarded as well.
      this.addRoute(name,b.signalingUrl,undefined,undefined,undefined,true);
    }
  }
  async sign(purpose, body) { return { body, publicKey: this.publicKey,
    signature: hex(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, courierBytes(purpose, body))) }; }
  async put(sender, job) {
    if (!this.enabled || (job?.body?.lanOnly && !this.lanEnabled)) throw new Error('courier_disabled');
    validateCourierJob(job, this.address); if (job.body.from !== sender) throw new Error('invalid_courier_author');
    await verifyCourierSignature(job, 'job', sender);
    await this.verifyRoute(job);
    if (job.body.route) await this.rememberRoute(sender,job.body.route);
    const existing = this.box.records.get(job.body.id.replaceAll('-', ''));
    if (job.body.attachment && (!existing || existing.status === 'stored')) await this.attachments.commit(job);
    let result;
    try { result = await this.box.put(sender, { protocol: MAILBOX_PROTOCOL, id: job.body.id.replaceAll('-', ''), expiresAt: job.body.expiresAt,
      ciphertext: Buffer.from(JSON.stringify(job)).toString('base64url') }); }
    // Quota rejection happens before writing the envelope. A disk failure may
    // have committed it: retain complete file parts in that ambiguous case.
    catch (error) { if (job.body.attachment && !existing && error.message === 'mailbox_full') await this.attachments.uncommit(job); throw error; }
    this.enqueue(() => this.flush()); return result;
  }
  async startFile(sender, job) {
    if (!this.enabled || (job?.body?.lanOnly && !this.lanEnabled)) throw new Error('courier_disabled');
    validateCourierJob(job, this.address); if (job.body.from !== sender || !job.body.attachment) throw new Error('invalid_courier_author');
    await verifyCourierSignature(job, 'job', sender);
    const existing = this.box.records.get(job.body.id.replaceAll('-', ''));
    if (existing && existing.status !== 'stored') {
      if (existing.sender !== sender || existing.digest !== digest(Buffer.from(JSON.stringify(job)).toString('base64url'))) throw new Error('attachment_conflict');
      return { received: [], acknowledged: existing.status === 'acknowledged', status: existing.status };
    }
    return this.attachments.start(job);
  }
  async cancelFile(sender, job) { return this.cancel(sender, job); }
  async cancel(sender, job) {
    // Expired jobs can still be identified and canceled; never extend their TTL.
    validateCourierJob(job, this.address, Math.min(Date.now(), (job?.body?.expiresAt ?? 0) - 1));
    if (job.body.from !== sender) throw new Error('invalid_courier_author');
    await verifyCourierSignature(job, 'job', sender);
    const staged = job.body.attachment && this.attachments.records.get(job.body.attachment.id);
    if (staged && JSON.stringify(staged.job) !== JSON.stringify(job)) throw new Error('attachment_conflict');
    const result = await this.box.cancel(sender, { protocol: MAILBOX_PROTOCOL, id: job.body.id.replaceAll('-', ''),
      expiresAt: job.body.expiresAt, ciphertext: Buffer.from(JSON.stringify(job)).toString('base64url') });
    if (job.body.attachment) await this.attachments.remove(job.body.attachment.id);
    return { ...result, canceled: result.status === 'canceled' }; // Already received copies cannot be recalled.
  }

  start() {
    if (this.started || !this.active) return;
    this.started = true;
    for (const route of this.routes.values()) this.connect(route);
    this.timer = setInterval(() => { this.enqueue(() => this.flush()); }, 3000); this.timer.unref();
  }
  enqueue(work) {
    if (!this.active || this.queued >= 32) return;
    this.queued++;
    this.chain = this.serialize(async () => { if (this.active) await work(); })
      .catch(() => {}).finally(() => { this.queued--; });
  }
  send(route, value) { if (!this.active || !route.ready || route.ws?.readyState !== WebSocket.OPEN) return false;
    if (route.ws.bufferedAmount > 512 * 1024) { route.ws.terminate(); return false; } route.ws.send(JSON.stringify(value)); return true; }
  connect(route) {
    if (!this.active) return; route.status = 'connecting';
    const ws = route.ws = this.createSocket(route.url, { maxPayload: 256 * 1024, handshakeTimeout: 15000, perMessageDeflate: false, followRedirects: false,
      ...(route.discovered ? { lookup: publicLookup } : {}),
      ...(route.ca ? { ca: route.ca } : {}), ...(route.servername ? { servername: route.servername } : {}), ...(route.host ? { headers: { Host: route.host } } : {}) });
    let challenged = false, registered = false;
    const registrationTimer = setTimeout(() => { if (!registered) ws.terminate(); }, 30000); registrationTimer.unref();
    ws.on('open', () => { if (this.active && route.ws === ws) ws.send(JSON.stringify({ type: 'register', address: this.address })); });
    ws.on('message', (raw, binary) => {
      if (binary || raw.length > 256 * 1024 || route.ws !== ws) return;
      this.enqueue(async () => {
        if (route.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        const msg = JSON.parse(raw.toString());
        if (!registered) {
          if (msg.type === 'register_challenge' && msg.address === this.address && !challenged && /^[a-f0-9]{64}$/.test(msg.challenge)) {
            challenged = true;
            const signature = hex(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, registrationProofBytes(this.address, msg.challenge)));
            if (this.active && route.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'register_proof', address: this.address, publicKey: this.publicKey, signature }));
          } else if (msg.type === 'registered' && challenged && msg.address === this.address) {
            if (msg.courierProtocol !== COURIER_PROTOCOL) { route.status = 'relay_outdated'; ws.close(); return; }
            registered = true; clearTimeout(registrationTimer); route.ready = true; route.attempt = 0; route.status = 'connected'; await this.flush();
          }
          return;
        }
        if (msg.type === 'peer_online' && route.watched.has(msg.address)) { route.online.add(msg.address); await this.flush(); }
        if (msg.type === 'peer_offline') route.online.delete(msg.address);
        if (msg.type === 'courier_receipt') await this.acceptReceipt(msg);
        if (msg.type === 'courier_file_request') await this.sendFilePart(route, msg);
      });
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(registrationTimer); if (route.ws !== ws) return;
      route.ready = false; route.watched.clear(); route.online.clear(); route.lastSent.clear();
      if (this.active) { if (route.status !== 'relay_outdated') route.status = 'retrying';
        route.reconnect = setTimeout(() => this.connect(route), Math.min(30000, 1000 * 2 ** Math.min(route.attempt++, 5)) + Math.random() * 1000); route.reconnect.unref(); }
    });
  }
  async flush() {
    if (!this.active) return;
    await this.box.serialized(() => this.box.sweep());
    await this.attachments.sweep();
    for (const [id,r] of this.attachments.records) if (['acknowledged','canceled','expired'].includes(this.box.records.get(r.job.body.id.replaceAll('-',''))?.status)) await this.attachments.remove(id);
    const records = [...this.box.records.values()].filter(r => r.status === 'stored' && this.authorize(r.sender));
    this.syncDiscovered(records);
    if (!this.ready) return;
    const routes = [...['lan', 'local-internet', 'internet'].map(name => this.routes.get(name)),
      ...[...this.routes.values()].filter(r => r.discovered)].filter(route => route?.ready);
    const allows = (route, body) => (route.name === 'lan' || !body.lanOnly) &&
      (!route.discovered || this.routeFor({body})?.body.signalingUrl === route.url);
    for (const route of routes) {
      const targets = new Set(records.map(record => this.decode(record).body).filter(body => allows(route,body)).map(body => body.to));
      for (const peer of route.watched) if (!targets.has(peer)) { this.send(route, { type: 'unwatch_peer', to: peer }); route.watched.delete(peer); route.online.delete(peer); }
      for (const peer of targets) if (!route.watched.has(peer) && route.watched.size < 256) { route.watched.add(peer); this.send(route, { type: 'watch_peer', to: peer }); }
    }
    let sent = 0;
    for (const record of records) {
      const job = this.decode(record);
      // Prefer LAN initially. A stale LAN presence must not starve Internet:
      // unacknowledged jobs may try the other route on the next flush.
      const route = routes.find(route => allows(route,job.body) && route.online.has(job.body.to) &&
        Date.now() - (route.lastSent.get(record.id) ?? 0) >= 10000);
      if (!route) continue;
      const hop = await this.sign('hop', { protocol: COURIER_PROTOCOL, courier: this.address, digest: digest(job.body.packet), id: job.body.id });
      if (!this.active || !this.authorize(record.sender) || this.box.records.get(record.id)?.status !== 'stored') continue;
      if (this.send(route, { type: 'courier_delivery', to: job.body.to, job, hop })) route.lastSent.set(record.id, Date.now());
      if (++sent >= 4) break; // bounded small batch, not one message per timer tick
    }
    for (const route of this.routes.values()) for (const id of route.lastSent.keys()) if (!this.box.records.has(id) || this.box.records.get(id).status !== 'stored') route.lastSent.delete(id);
  }
  async acceptReceipt(msg) {
    if (!isValidAccountId(msg.from) || typeof msg.receipt !== 'string' || msg.receipt.length > 2048 || !/^[a-f0-9]{32}$/.test(msg.id)) return;
    const record = this.box.records.get(msg.id); if (!record || record.status !== 'stored') return;
    const job = this.decode(record); const receipt = JSON.parse(msg.receipt); const b = receipt?.body;
    if (!b || b.protocol !== COURIER_PROTOCOL || b.from !== job.body.to || msg.from !== b.from || b.to !== job.body.from || b.id !== job.body.id ||
        b.digest !== digest(job.body.packet)) throw new Error('invalid_courier_receipt');
    await verifyCourierSignature(receipt, 'receipt', b.from);
    await this.box.acknowledge([record.id], { [record.id]: msg.receipt });
    if (job.body.attachment) await this.attachments.remove(job.body.attachment.id);
    await this.flush();
  }
  // Recipient proof is checked by the HTTP boundary. Listing never consumes
  // a job; only the existing recipient-signed durable-save receipt can do so.
  async inbox(address, body, scope, sender) {
    if (!body || (body.cursor !== undefined && (typeof body.cursor !== 'string' || (body.cursor !== '' && !/^[a-f0-9]{32}$/.test(body.cursor)))))
      throw new Error('invalid_courier_job');
    await this.box.sweep();
    const records = [...this.box.records.values()].filter(r => r.status === 'stored' && this.authorize(r.sender)&&(!sender||r.sender===sender))
      .filter(r => { const j = this.decode(r); return j.body.to === address && (scope === 'lan' || !j.body.lanOnly); });
    records.sort((a, b) => a.id.localeCompare(b.id));
    const after = body.cursor ? records.findIndex(r => r.id > body.cursor) : 0;
    if (after < 0) return { protocol: 'automesh-inbox-v1', deliveries: [], cursor: '' };
    const deliveries = []; let bytes = 0, cursor = '';
    for (let i = after; i < records.length; i++) {
      const record = records[i], job = this.decode(record);
      const hop = await this.sign('hop', { protocol: COURIER_PROTOCOL, courier: this.address, digest: digest(job.body.packet), id: job.body.id });
      const delivery = { from: this.address, job, hop }, cost = Buffer.byteLength(JSON.stringify(delivery));
      if (deliveries.length && (deliveries.length >= 8 || bytes + cost > 384 * 1024)) { cursor = records[i - 1].id; break; }
      deliveries.push(delivery); bytes += cost;
    }
    return { protocol: 'automesh-inbox-v1', deliveries, cursor };
  }
  async inboxParts(address, body, scope, sender) {
    const request = body?.request;
    if (!validAttachmentRequest(request) || request.body.from !== address || request.body.to !== this.address) throw new Error('invalid_courier_job');
    const b = request.body, r = this.attachments.records.get(b.id);
    if (!r?.complete || !this.authorize(r.job.body.from) || r.job.body.to !== address ||sender&&r.job.body.from!==sender||
        (scope !== 'lan' && r.job.body.lanOnly) || this.box.records.get(r.job.body.id.replaceAll('-', ''))?.status !== 'stored')
      throw new Error('sender_not_allowed');
    await verifyCourierSignature(request, 'attachment-request', address);
    // Four adjacent encrypted parts per proof keep HTTP fallback below rate
    // limits and bounded in memory. Every part is independently AEAD checked.
    const parts = [];
    for (let index = b.index; index < Math.min(b.index + 4, r.job.body.attachment.chunks); index++)
      parts.push({ index, cipher: await this.attachments.get(b.id, index) });
    return { id: b.id, parts };
  }
  async acknowledgeInbox(address, body, sender) {
    if (!body || typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id) ||
        typeof body.receipt !== 'string' || body.receipt.length > 2048) throw new Error('invalid_courier_receipt');
    const record = this.box.records.get(body.id);
    if (!record||sender&&record.sender!==sender) throw new Error('invalid_courier_receipt');
    if (record.status === 'acknowledged') {
      if (record.receipt !== body.receipt || JSON.parse(record.receipt).body.from !== address) throw new Error('invalid_courier_receipt');
    } else await this.acceptReceipt({ ...body, from: address });
    if (this.box.records.get(body.id)?.status !== 'acknowledged') throw new Error('invalid_courier_receipt');
    return { acknowledged: true };
  }
  async sendFilePart(route, msg) {
    if (!validAttachmentRequest(msg.request) || msg.to !== this.address || msg.request.body.from !== msg.from || msg.request.body.to !== this.address) return;
    const b = msg.request.body, r = this.attachments.records.get(b.id);
    if (!r?.complete || !this.authorize(r.job.body.from) || r.job.body.to !== msg.from || (route.name !== 'lan' && r.job.body.lanOnly) ||
        this.box.records.get(r.job.body.id.replaceAll('-', ''))?.status !== 'stored') return;
    await verifyCourierSignature(msg.request, 'attachment-request', msg.from);
    const cipher = await this.attachments.get(b.id, b.index);
    this.send(route, { type: 'courier_file_chunk', to: msg.from, id: b.id, index: b.index, requestId: b.requestId, cipher });
  }
  async removeMember(address) {
    await this.box.removeWhere(record => record.sender === address);
    for (const [id, record] of this.attachments.records) if (record.job.body.from === address) await this.attachments.remove(id);
    if ([...this.learnedRoutes.values()].some(r => r.body.to === address)) {
      const next = new Map([...this.learnedRoutes].filter(([,r]) => r.body.to !== address));
      await writeAtomic(this.directory,'courier-routes.json',{version:1,routes:[...next.values()]});this.learnedRoutes = next;
    }
  }
  // Only called behind the authenticated member boundary. A profile can see
  // its own signed jobs, including jobs forgotten by an older client/backup.
  async outbox(sender, body) {
    const cursor=body?.cursor ?? '';
    if(typeof cursor!=='string'||cursor!==''&&!/^[a-f0-9]{32}$/.test(cursor))throw Error('invalid_courier_job');
    await this.box.serialized(()=>this.box.sweep());
    await this.attachments.sweep();
    const jobs=new Map();
    for(const r of this.box.records.values())if(r.sender===sender&&r.status==='stored')jobs.set(r.id,this.decode(r));
    for(const r of this.attachments.records.values())if(r.job.body.from===sender&&!this.box.records.has(r.job.body.id.replaceAll('-','')))
      jobs.set(r.job.body.id.replaceAll('-',''),r.job);
    const entries=[...jobs].sort(([a],[b])=>a.localeCompare(b)).filter(([id])=>id>cursor);
    const page=[];let bytes=0;
    for(const [,job]of entries){const size=Buffer.byteLength(JSON.stringify(job));if(page.length&&(page.length>=8||bytes+size>384*1024))break;page.push(job);bytes+=size;}
    return {protocol:'automesh-outbox-inventory-v1',jobs:page,cursor:page.length<entries.length?page.at(-1).body.id.replaceAll('-',''):''};
  }
  stats(address) {
    const records = [...this.box.records.values()].filter(record => !address || record.sender === address);
    const files = [...this.attachments.records.values()].filter(record => !address || record.job.body.from === address);
    return { ...this.box.stats(), messages: records.filter(record => record.status === 'stored').length,
    bytes: records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)), 0), address: this.address, relay: this.relay, status: this.status, enabled: this.enabled,
    attachments: { files: files.length, bytes: files.reduce((sum, record) => sum + this.attachments.cost(record.job.body.attachment), 0),
      uploading: files.filter(r => !r.complete).length, maxFiles: address ? this.attachments.maxFilesPerProfile : this.attachments.maxFiles,
      maxFilesPerProfile: this.attachments.maxFilesPerProfile, uploadIdleMs: this.attachments.stats().uploadIdleMs }, fileQueue: attachmentLimits(),
    inventoryProtocol:'automesh-outbox-inventory-v1',
    queueLifecycle: 'automesh-queue-v1', lanEnabled: this.lanEnabled, deliveryScopes: true, inboxProtocol: 'automesh-inbox-v1',
    routingProtocol: COURIER_ROUTE_PROTOCOL, signalingEnabled: this.lanEnabled || this.localInternetEnabled,
    discoveredRoutes: [...this.routes.values()].filter(r => r.discovered).length,
    discoveredRoutesConnected:[...this.routes.values()].filter(r=>r.discovered&&r.ready).length,
    routes: { lan: this.lanEnabled ? this.routes.get('lan')?.status ?? 'connecting' : 'disabled',
      internet: this.routes.get('internet')?.status ?? 'disabled',
      localInternet: this.routes.get('local-internet')?.status ?? 'disabled' } }; }
  async close() { this.active = false; clearInterval(this.timer);
    for (const route of this.routes.values()) { route.ready = false; clearTimeout(route.reconnect); route.ws?.terminate(); }
    await this.chain; await this.box.chain; await this.attachments.chain; this.privateKey = null; }
}
