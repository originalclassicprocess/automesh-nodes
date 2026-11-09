import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { privateDirectory, writeAtomic, removeAtomic } from './files.js';
import { DiskMailbox } from './mailbox.js';
import { MAILBOX_PROTOCOL } from '../../protocol/src/protocol.js';
import { isValidAccountId } from '../../protocol/src/bech32m.js';
import { DEVICE_DIRECTORY, DEVICE_MAIL_TTL, deviceCanonical, deviceObjectDigest, verifyDirectoryRoster, directoryMember, verifyDeviceTransport } from '../../protocol/src/devices.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const denied = () => { throw new Error('device_denied'); };
// Application serializes all calls with existing queue operations. Only public
// owner/device statements and opaque envelopes persist here, NEVER device keys.
export class DeviceDirectory {
  constructor(directory, options) { this.directory = join(directory, 'devices-v2'); this.options = options; this.entries = new Map(); this.boxes = new Map(); this.failed = false; }
  async initialize() {
    await privateDirectory(this.directory);
    for (const name of await readdir(this.directory)) {
      if (/^\.pending-[a-f0-9]{32}$/.test(name)) continue;
      if (name === 'boxes') continue;
      if (!/^[a-f0-9]{64}\.json$/.test(name) || this.entries.size >= 8) throw new Error('corrupt_device_directory');
      const path = join(this.directory, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('corrupt_device_directory');
      const entry = JSON.parse(await readFile(path, 'utf8')), owner = entry.roster?.record?.author;
      if (hash(owner || '') + '.json' !== name || entry.version !== 2 || !Array.isArray(entry.keys) || entry.keys.length > 256) throw new Error('corrupt_device_directory');
      await verifyDirectoryRoster(entry.roster, owner, entry.roster.record.createdAt, webcrypto.subtle);
      this.authority(entry.roster);
      for (const item of entry.keys) {
        await verifyDeviceTransport(item.bundle, 'prekeys', item.bundle?.body?.device, webcrypto.subtle);
        this.validateKeys(item.bundle.body, owner, false);
        if (!Array.isArray(item.used) || item.used.length > 32 || item.used.some(r => !id(r.keyId) || !id(r.allocation) || !uuid(r.eventId) || !isValidAccountId(r.sender) || !isValidAccountId(r.senderOwner)) ||
          new Set(item.used.map(r => r.keyId)).size !== item.used.length || item.used.some(r => !item.bundle.body.keys.some(k => k.id === r.keyId))) throw new Error('corrupt_device_directory');
      }
      this.entries.set(owner, entry);
      const endpoints = [owner, ...entry.roster.record.body.devices.map(m => m.certificate.record.body.device)];
      for (const device of endpoints) await this.box(owner, device);
    }
    return this;
  }
  authority(roster) {
    const a = roster.record.body.directory;
    if (a.nodeId !== this.options.nodeId || a.publicKey !== this.options.publicKey) denied();
  }
  entry(owner, allowExpired = false) {
    if (this.failed || !this.options.isOwner(owner)) denied();
    const entry = this.entries.get(owner);
    if (!entry || !allowExpired && entry.roster.record.expiresAt <= this.options.now()) denied(); return entry;
  }
  active(owner, device) { const entry = this.entry(owner); if (!directoryMember(entry.roster, device, this.options.now())) denied(); return entry; }
  async save(owner, entry) {
    const size = Buffer.byteLength(JSON.stringify(entry)), old = this.entries.get(owner);
    const growth = size - (old ? Buffer.byteLength(JSON.stringify(old)) : 0);
    if (size > 2 * 1024 * 1024 || growth > this.options.availableBytes()) throw new Error('device_capacity');
    try { await writeAtomic(this.directory, hash(owner) + '.json', entry); }
    catch (error) { this.failed = true; throw error; }
    this.entries.set(owner, entry);
  }
  async box(owner, device) {
    const name = hash(owner + ':' + device);
    if (!this.boxes.has(name)) this.boxes.set(name, await new DiskMailbox(join(this.directory, 'boxes', name), this.options).initialize());
    return this.boxes.get(name);
  }
  stats() {
    const metadata = [...this.entries.values()].reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0);
    return [...this.boxes.values()].reduce((total, box) => ({ bytes: total.bytes + box.stats().bytes, messages: total.messages + box.stats().messages }), { bytes: metadata, messages: 0 });
  }
  async removeOwner(owner) {
    const entry = this.entries.get(owner); if (!entry) return;
    for (const device of [owner, ...entry.roster.record.body.devices.map(m => m.certificate.record.body.device)]) {
      const box = await this.box(owner, device); await box.removeWhere(() => true);
    }
    await removeAtomic(this.directory, hash(owner) + '.json'); this.entries.delete(owner);
  }
  validateKeys(body, owner, fresh = true) {
    if (body?.protocol !== DEVICE_DIRECTORY || body.owner !== owner || !isValidAccountId(body.device) || body.nodeId !== this.options.nodeId ||
      !Number.isSafeInteger(body.expiresAt) || (fresh && body.expiresAt <= this.options.now()) || body.expiresAt > this.options.now() + DEVICE_MAIL_TTL ||
      !Array.isArray(body.keys) || !body.keys.length || body.keys.length > 32 || new Set(body.keys.map(k => k.id)).size !== body.keys.length ||
      body.keys.some(k => !id(k.id) || !/^04[a-f0-9]{128}$/.test(k.publicKey))) denied();
  }
  async handle(path, identity, body) {
    const now = this.options.now();
    if (path === '/devices/publish') {
      const owner = identity.address;
      if (!this.options.isOwner(owner)) denied();
      const roster = await verifyDirectoryRoster(body.roster, owner, now, webcrypto.subtle); this.authority(roster);
      const current = this.entries.get(owner), digest = await deviceObjectDigest(roster, webcrypto.subtle);
      if (current) {
        const old = current.roster, oldDigest = await deviceObjectDigest(old, webcrypto.subtle);
        if (roster.record.body.sequence < old.record.body.sequence || roster.record.body.sequence === old.record.body.sequence && digest !== oldDigest ||
          roster.record.body.sequence === old.record.body.sequence + 1 && roster.record.body.previous !== oldDigest ||
          old.record.body.devices.filter(m => m.revokedAt !== null).some(m => !roster.record.body.devices.some(n => n.certificate.record.id === m.certificate.record.id && n.revokedAt !== null))) throw new Error('device_policy_conflict');
      }
      await this.save(owner, { version: 2, roster, keys: current?.keys ?? [] }); return { published: true, sequence: roster.record.body.sequence, digest };
    }
    if (path === '/devices/policy') {
      if (!isValidAccountId(body.owner) || !/^[a-f0-9]{64}$/.test(body.nonce)) denied();
      // Only the physical root signer can recover expired PUBLIC control
      // metadata. Messaging authorization still rejects expired statements.
      const entry = this.entry(body.owner, identity.address === body.owner), roster = entry.roster;
      return { roster, checkpoint: await this.options.sign('device-checkpoint-v2', { protocol: DEVICE_DIRECTORY, nodeId: this.options.nodeId,
        owner: body.owner, sequence: roster.record.body.sequence, digest: await deviceObjectDigest(roster, webcrypto.subtle),
        nonce: body.nonce, issuedAt: now, expiresAt: now + 30000 }) };
    }
    if (path === '/devices/grant') {
      this.active(body.owner, identity.address);
      if (!isValidAccountId(body.sender) || typeof body.revoke !== 'boolean') denied();
      await this.options.grant(body.owner, body.sender, body.revoke);
      return { changed: true };
    }
    if (path === '/devices/keys') {
      const entry = this.active(body.owner, identity.address), bundle = await verifyDeviceTransport(body.bundle, 'prekeys', identity.address, webcrypto.subtle);
      this.validateKeys(bundle.body, body.owner); if (bundle.body.device !== identity.address) denied();
      const next = structuredClone(entry); next.keys = next.keys.filter(k => k.bundle.body.expiresAt > now);
      const bytes = JSON.stringify(bundle), existing = next.keys.find(k => k.bundle.body.device === identity.address && JSON.stringify(k.bundle) === bytes);
      if (!existing) {
        const known = new Set(next.keys.flatMap(k => k.bundle.body.keys.map(key => key.id)));
        if (next.keys.length >= 256 || bundle.body.keys.some(k => known.has(k.id))) throw new Error('device_capacity');
        next.keys.push({ bundle, used: [] }); await this.save(body.owner, next);
      }
      return { published: true };
    }
    if (path === '/devices/allocate') {
      const target = this.active(body.owner, body.device);
      const sender = await verifyDirectoryRoster(body.senderPolicy, body.senderOwner, now, webcrypto.subtle);
      if (!directoryMember(sender, identity.address, now) || !uuid(body.eventId) || !this.options.allowed(body.owner, body.senderOwner)) denied();
      const local = this.entries.get(body.senderOwner);
      if (local && (!directoryMember(local.roster, identity.address, now) || sender.record.body.sequence < local.roster.record.body.sequence)) denied();
      const allocation = hash(identity.address + ':' + body.device + ':' + body.eventId).slice(0, 32);
      const next = structuredClone(target);
      for (const item of next.keys.filter(k => k.bundle.body.device === body.device && k.bundle.body.expiresAt > now)) {
        const used = item.used.find(r => r.allocation === allocation && r.sender === identity.address);
        if (used) {
          if (used.senderOwner !== body.senderOwner || used.eventId !== body.eventId) denied();
          return { allocation, key: item.bundle.body.keys.find(k => k.id === used.keyId), bundle: item.bundle };
        }
      }
      for (const item of next.keys.filter(k => k.bundle.body.device === body.device && k.bundle.body.expiresAt > now)) {
        const key = item.bundle.body.keys.find(k => !item.used.some(r => r.keyId === k.id));
        if (!key) continue;
        item.used.push({ keyId: key.id, sender: identity.address, senderOwner: body.senderOwner, allocation, eventId: body.eventId }); await this.save(body.owner, next);
        return { allocation, key, bundle: item.bundle };
      }
      throw new Error('device_keys_unavailable');
    }
    if (path === '/devices/put') {
      const signed = await verifyDeviceTransport(body.mail, 'mail', identity.address, webcrypto.subtle), b = signed.body;
      const entry = this.active(b.toOwner, b.toDevice);
      if (b.protocol !== DEVICE_DIRECTORY || b.nodeId !== this.options.nodeId || b.from !== identity.address || !isValidAccountId(b.fromOwner) || !id(b.id) ||
        !id(b.keyId) || !uuid(b.eventId) || !Number.isSafeInteger(b.expiresAt) || b.expiresAt <= now || b.expiresAt > now + DEVICE_MAIL_TTL ||
        typeof b.enc !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(b.enc) || typeof b.cipher !== 'string' || !/^[A-Za-z0-9_-]{1,48000}$/.test(b.cipher)) denied();
      const reservation = entry.keys.find(k => k.bundle.body.device === b.toDevice && k.bundle.body.expiresAt >= b.expiresAt &&
        k.used.some(r => r.sender === identity.address && r.senderOwner === b.fromOwner && r.allocation === b.id && r.keyId === b.keyId && r.eventId === b.eventId));
      if (!reservation || !this.options.allowed(b.toOwner, b.fromOwner)) denied();
      const localSender = this.entries.get(b.fromOwner);
      if (localSender && !directoryMember(localSender.roster, identity.address, now)) denied();
      const box = await this.box(b.toOwner, b.toDevice), ciphertext = Buffer.from(deviceCanonical(signed)).toString('base64url');
      box.maxBytes = Math.max(0, this.options.availableBytes() + box.stats().bytes);
      try { return await box.put(identity.address, { protocol: MAILBOX_PROTOCOL, id: b.id, expiresAt: b.expiresAt, ciphertext }); }
      finally { box.maxBytes = this.options.maxBytes; }
    }
    if (path === '/devices/list') { this.active(body.owner, identity.address); return { envelopes: await (await this.box(body.owner, identity.address)).list() }; }
    if (path === '/devices/ack') {
      this.active(body.owner, identity.address); const box = await this.box(body.owner, identity.address);
      const receipt = await verifyDeviceTransport(body.receipt, 'receipt', identity.address, webcrypto.subtle), b = receipt.body;
      const record = box.records.get(b.id);
      if (!record || b.nodeId !== this.options.nodeId || b.device !== identity.address || b.digest !== record.digest || b.sender !== record.sender ||
        JSON.stringify(receipt).length > 2048) denied();
      return box.acknowledge([b.id], { [b.id]: JSON.stringify(receipt) });
    }
    if (path === '/devices/receipts') {
      const entry = this.entry(body.owner);
      if (body.device !== body.owner && !entry.roster.record.body.devices.some(m => m.certificate.record.body.device === body.device)) denied();
      return { receipts: await (await this.box(body.owner, body.device)).receipts(identity.address, body.ids) };
    }
    denied();
  }
}
