import { readFile, readdir, unlink, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isMessageId, normalizeEnvelope, MAX_MAIL_TTL_MS } from '../../protocol/src/protocol.js';
import { privateDirectory, writeAtomic, removeAtomic } from './files.js';
import { queueLimit } from './queue-quota.js';

const MAX_RECORD_BYTES = 192 * 1024;
const PROFILE_MESSAGE_LIMIT=100,PROFILE_MESSAGE_BYTES=4*1024*1024;
export class DiskMailbox {
  constructor(directory, { maxBytes = 64 * 1024 * 1024, maxMessages = 1000, now = Date.now, retainOutcomes = false } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 24 * 1024 || maxBytes > 512 * 1024 * 1024 ||
        !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 5000) throw new Error('invalid_mailbox_limits');
    this.directory = directory; this.maxBytes = maxBytes; this.maxMessages = maxMessages; this.now = now;
    this.retainOutcomes = retainOutcomes; this.records = new Map(); this.chain = Promise.resolve();
  }
  async initialize() {
    await privateDirectory(this.directory);
    const files = await readdir(this.directory);
    for (const name of files) {
      if (name.startsWith('.pending-')) { // only our bounded, known crash leftovers
        if (/^\.pending-[a-f0-9]{32}$/.test(name)) await unlink(join(this.directory, name));
        continue;
      }
      if (!/^[a-f0-9]{32}\.json$/.test(name)) throw new Error('unexpected_mailbox_file');
      if (this.records.size >= 2 * this.maxMessages) throw new Error('mailbox_disk_limit');
      const path = join(this.directory, name); const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) throw new Error('corrupt_mailbox');
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.id !== name.slice(0, -5) || !isMessageId(record.id) || typeof record.sender !== 'string' ||
          !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) ||
          record.expiresAt > this.now() + MAX_MAIL_TTL_MS || !/^[a-f0-9]{64}$/.test(record.digest) ||
          !['stored', 'acknowledged', ...(this.retainOutcomes ? ['canceled','expired'] : [])].includes(record.status) ||
          (record.receipt !== undefined && (record.status !== 'acknowledged' || typeof record.receipt !== 'string' || record.receipt.length > 2048))) throw new Error('corrupt_mailbox');
      if (record.expiresAt > this.now() && record.status === 'stored') {
        normalizeEnvelope(record, this.now());
        if (digest(record.ciphertext) !== record.digest) throw new Error('corrupt_mailbox');
      }
      if (record.status !== 'stored' && record.ciphertext !== undefined) throw new Error('corrupt_mailbox');
      if (record.finishedAt !== undefined && (!Number.isSafeInteger(record.finishedAt) || record.finishedAt < 0)) throw new Error('corrupt_mailbox');
      this.records.set(record.id, record);
    }
    await this.sweep();
    if (this.stats().bytes > this.maxBytes) throw new Error('mailbox_disk_limit');
    return this;
  }
  serialized(work) {
    const result = this.chain.then(work); this.chain = result.catch(() => {}); return result;
  }
  async commitTerminal(id, record) {
    try { await writeAtomic(this.directory, `${id}.json`, record); }
    catch (error) { this.failed = true; throw error; }
    this.records.set(id, record);
  }
  async sweep() {
    if (this.failed) throw new Error('mailbox_restart_required');
    for (const [id, record] of this.records) {
      if (this.retainOutcomes && record.status === 'stored' && record.expiresAt <= this.now()) {
        const { ciphertext: _ciphertext, ...terminal } = record;
        terminal.status = 'expired'; terminal.finishedAt = record.expiresAt;
        await this.commitTerminal(id,terminal);
      }
      const current = this.records.get(id);
      const deadline = this.retainOutcomes && current.status !== 'stored' ? (current.finishedAt ?? current.expiresAt) + 30 * 86400000 : current.expiresAt;
      if (deadline <= this.now()) { await removeAtomic(this.directory, `${id}.json`); this.records.delete(id); }
    }
  }
  cancel(sender, envelope) {
    return this.serialized(async () => {
      await this.sweep();
      const record = this.records.get(envelope.id), hash = digest(envelope.ciphertext);
      if (record && (record.sender !== sender || record.digest !== hash || record.expiresAt !== envelope.expiresAt)) throw new Error('message_conflict');
      if (record && record.status !== 'stored') return { status: record.status };
      // Keep an idempotent tombstone even if a delayed upload has not arrived yet.
      if (!record && this.records.size >= 2 * this.maxMessages) throw queueLimit('node_messages');
      const terminal = { protocol: envelope.protocol, id: envelope.id, expiresAt: envelope.expiresAt,
        sender, digest: hash, createdAt: record?.createdAt ?? this.now(), finishedAt: this.now(), status: 'canceled' };
      if (this.stats().bytes - (record ? size(record) : 0) + size(terminal) > this.maxBytes) throw queueLimit('storage');
      await this.commitTerminal(envelope.id,terminal);
      return { status: 'canceled' };
    });
  }
  outcomes(sender, ids) {
    return this.serialized(async () => {
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !isMessageId(id))) throw new Error('invalid_ack');
      await this.sweep();
      return ids.map(id => this.records.get(id)).filter(r => r?.sender === sender && ['canceled','expired'].includes(r.status))
        .map(({id,digest,status}) => ({id,digest,status}));
    });
  }

  stats() {
    const stored = [...this.records.values()].filter(record => record.status === 'stored');
    return { messages: stored.length, bytes: [...this.records.values()].reduce((sum, record) => sum + size(record), 0), maxBytes: this.maxBytes };
  }
  quota(sender){
    const stored=[...this.records.values()].filter(r=>r.status==='stored'),own=stored.filter(r=>r.sender===sender);
    return {profileMessages:own.length,profileMessageLimit:PROFILE_MESSAGE_LIMIT,profileMessageBytes:own.reduce((sum,r)=>sum+size(r),0),profileMessageByteLimit:PROFILE_MESSAGE_BYTES,
      nodeMessages:stored.length,nodeMessageLimit:this.maxMessages,nodeRecords:this.records.size,nodeRecordLimit:2*this.maxMessages};
  }
  removeWhere(predicate) {
    return this.serialized(async () => {
      for (const [id, record] of this.records) if (predicate(record)) {
        await removeAtomic(this.directory, `${id}.json`); this.records.delete(id);
      }
    });
  }
  put(sender, value) {
    return this.serialized(async () => {
      await this.sweep(); const envelope = normalizeEnvelope(value, this.now());
      if (Buffer.from(envelope.ciphertext, 'base64url').toString('base64url') !== envelope.ciphertext) throw new Error('invalid_envelope');
      const hash = digest(envelope.ciphertext); const existing = this.records.get(envelope.id);
      if (existing) {
        if (existing.sender !== sender || existing.digest !== hash || existing.expiresAt !== envelope.expiresAt) throw new Error('message_conflict');
        return { id: envelope.id, status: existing.status };
      }
      const record = { ...envelope, sender, createdAt: this.now(), digest: hash, status: 'stored' };
      const sameSender = [...this.records.values()].filter(item => item.sender === sender && item.status === 'stored');
      if (this.stats().messages >= this.maxMessages || this.records.size >= 2 * this.maxMessages) throw queueLimit('node_messages');
      if (sameSender.length >= PROFILE_MESSAGE_LIMIT || sameSender.reduce((sum, item) => sum + size(item), 0) + size(record) > PROFILE_MESSAGE_BYTES) throw queueLimit('profile_messages');
      if (this.stats().bytes + size(record) > this.maxBytes) throw queueLimit('storage');
      await writeAtomic(this.directory, `${record.id}.json`, record); this.records.set(record.id, record);
      return { id: record.id, status: 'stored' };
    });
  }
  list() {
    return this.serialized(async () => {
      await this.sweep();
      const candidates = [...this.records.values()].filter(record => record.status === 'stored')
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, 10)
        .map(({ digest: _digest, status: _status, ...record }) => record);
      const result = []; let bytes = 0;
      for (const record of candidates) { bytes += size(record); if (bytes > 384 * 1024) break; result.push(record); }
      return result;
    });
  }
  acknowledge(ids, receipts = {}) {
    return this.serialized(async () => {
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !isMessageId(id))) throw new Error('invalid_ack');
      if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts) || Object.keys(receipts).length > 50 ||
          Object.entries(receipts).some(([id, value]) => !ids.includes(id) || typeof value !== 'string' || value.length > 2048)) throw new Error('invalid_ack');
      await this.sweep();
      for (const id of new Set(ids)) {
        const record = this.records.get(id); if (!record || record.status !== 'stored') continue;
        const { ciphertext: _ciphertext, ...receipt } = record; receipt.status = 'acknowledged'; if (this.retainOutcomes) receipt.finishedAt = this.now();
        if (receipts[id]) receipt.receipt = receipts[id];
        await writeAtomic(this.directory, `${id}.json`, receipt); this.records.set(id, receipt);
      }
      return { acknowledged: ids.length };
    });
  }
  receipts(sender, ids) {
    return this.serialized(async () => {
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !isMessageId(id))) throw new Error('invalid_ack');
      await this.sweep();
      return ids.map(id => this.records.get(id)).filter(record => record?.sender === sender && record.status === 'acknowledged' && record.receipt)
        .map(record => ({ id: record.id, digest: record.digest, receipt: record.receipt }));
    });
  }
}
const digest = value => createHash('sha256').update(value).digest('hex');
const size = record => Buffer.byteLength(JSON.stringify(record));
