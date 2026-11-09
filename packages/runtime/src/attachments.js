import { readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { privateDirectory, writeAtomic, removeAtomic } from './files.js';
import { fileQueuePolicy, ATTACHMENT_MAX_PENDING_CEILING, ATTACHMENT_CHUNK_BYTES, FILE_POLICY_BYTES, attachmentPartBytes, validateAttachment } from '../../protocol/src/attachment-protocol.js';
import { queueLimit, UPLOAD_IDLE_MS } from './queue-quota.js';
// No names, MIME types or file keys here. Reserve the entire bounded disk budget
// before accepting a part; abandoned partial uploads also have an idle timeout.
export class DiskAttachments {
  constructor(directory, maxBytes, { maxFiles, maxFilesPerProfile, now = Date.now } = {}) {
    ({ maxFiles, maxFilesPerProfile } = fileQueuePolicy({ maxFiles, maxFilesPerProfile }));
    this.directory = directory; this.maxBytes = maxBytes; this.maxFiles = maxFiles; this.maxFilesPerProfile = maxFilesPerProfile; this.now = now;
    this.records = new Map(); this.chain = Promise.resolve();
  }
  // HTTP uploads and WSS receipts/expiry run on separate actors. Keep disk
  // mutation atomic relative to both: cleanup must not race a part write and
  // leave an orphan which would prevent the next node startup.
  serialized(work) { const result = this.chain.then(work); this.chain = result.catch(() => {}); return result; }
  cost(a) { return Math.ceil(a.bytes * 4 / 3) + a.chunks * 256 + 8192; }
  stats() { return { files: this.records.size, bytes: [...this.records.values()].reduce((n, r) => n + this.cost(r.job.body.attachment), 0),
    maxFiles: this.maxFiles, maxFilesPerProfile: this.maxFilesPerProfile,
    uploading: [...this.records.values()].filter(r => !r.complete).length, uploadIdleMs: UPLOAD_IDLE_MS }; }
  async json(name, limit) {
    const path = join(this.directory, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('corrupt_attachment');
    return JSON.parse(await readFile(path, 'utf8'));
  }
  async initialize() {
    await privateDirectory(this.directory); const names = await readdir(this.directory);
    if (names.length > ATTACHMENT_MAX_PENDING_CEILING * (Math.ceil(FILE_POLICY_BYTES / ATTACHMENT_CHUNK_BYTES) + 2)) throw new Error('attachment_disk_limit');
    for (const name of names) {
      if (/^\.pending-[a-f0-9]{32}$/.test(name)) { await unlink(join(this.directory, name)); continue; }
      if (/^[a-f0-9]{32}\.json$/.test(name)) {
        const r = await this.json(name, 192 * 1024); validateAttachment(r.job?.body?.attachment);
        if (r.job.body.attachment.id !== name.slice(0, -5) || typeof r.complete !== 'boolean' || !Number.isSafeInteger(r.job.body.expiresAt)) throw new Error('corrupt_attachment');
        const info = await lstat(join(this.directory, name));
        this.records.set(name.slice(0, -5), { ...r, parts: new Set(), lastProgressAt: Math.min(this.now(), info.mtimeMs) });
      } else if (!/^[a-f0-9]{32}-[0-9]{1,4}\.json$/.test(name)) throw new Error('unexpected_attachment_file');
    }
    // Lowering an operator quota blocks new uploads, never erases existing mail.
    if (this.records.size > ATTACHMENT_MAX_PENDING_CEILING) throw new Error('attachment_disk_limit');
    for (const name of names.filter(n => /^[a-f0-9]{32}-[0-9]{1,4}\.json$/.test(n))) {
      const [id, part] = name.slice(0, -5).split('-'), r = this.records.get(id), index = Number(part);
      if (!r || part !== String(index)) throw new Error('orphan_attachment_part');
      const v = await this.json(name, 48 * 1024); this.decode(r, index, v.cipher); r.parts.add(index);
      r.lastProgressAt = Math.max(r.lastProgressAt, Math.min(this.now(), (await lstat(join(this.directory, name))).mtimeMs));
    }
    await this.sweep();
    if (this.stats().bytes > this.maxBytes) throw new Error('attachment_disk_limit');
    for (const r of this.records.values()) if (r.complete) await this.verify(r);
    return this;
  }
  decode(r, index, cipher) {
    if (typeof cipher !== 'string' || cipher.length > 45000 || !/^[A-Za-z0-9_-]+$/.test(cipher)) throw new Error('invalid_attachment_part');
    const bytes = Buffer.from(cipher, 'base64url');
    if (bytes.toString('base64url') !== cipher || bytes.length !== attachmentPartBytes(r.job.body.attachment, index)) throw new Error('invalid_attachment_part');
    return bytes;
  }
  start(job) { return this.serialized(() => this.startUnlocked(job)); }
  async startUnlocked(job) {
    await this.sweepUnlocked(); const a = validateAttachment(job.body.attachment), existing = this.records.get(a.id);
    if (existing) {
      if (JSON.stringify(existing.job) !== JSON.stringify(job)) throw new Error('attachment_conflict');
      return { received: [...existing.parts], complete: existing.complete };
    }
    if ([...this.records.values()].filter(r => r.job.body.from === job.body.from).length >= this.maxFilesPerProfile) throw queueLimit('profile_files');
    if (this.records.size >= this.maxFiles) throw queueLimit('node_files');
    if (this.stats().bytes + this.cost(a) > this.maxBytes) throw queueLimit('storage');
    await writeAtomic(this.directory, `${a.id}.json`, { job, complete: false });
    this.records.set(a.id, { job, complete: false, parts: new Set(), lastProgressAt: this.now() }); return { received: [], complete: false };
  }
  put(sender, id, index, cipher) { return this.serialized(() => this.putUnlocked(sender, id, index, cipher)); }
  async putUnlocked(sender, id, index, cipher) {
    await this.sweepUnlocked(); const r = this.records.get(id);
    if (!r || r.job.body.from !== sender) throw new Error('attachment_denied');
    this.decode(r, index, cipher);
    if (r.parts.has(index)) {
      if ((await this.json(`${id}-${index}.json`, 48 * 1024)).cipher !== cipher) throw new Error('attachment_conflict');
    } else {
      await writeAtomic(this.directory, `${id}-${index}.json`, { cipher }); r.parts.add(index); r.lastProgressAt = this.now();
    }
    return { stored: index };
  }
  async verify(r) {
    const a = r.job.body.attachment;
    if (r.parts.size !== a.chunks) throw new Error('attachment_incomplete');
    const hash = createHash('sha256');
    for (let i = 0; i < a.chunks; i++) hash.update(this.decode(r, i, (await this.json(`${a.id}-${i}.json`, 48 * 1024)).cipher));
    if (hash.digest('hex') !== a.digest) throw new Error('attachment_digest_mismatch');
  }
  commit(job) { return this.serialized(() => this.commitUnlocked(job)); }
  uncommit(job) { return this.serialized(async () => {
    const r = this.records.get(job.body.attachment?.id);
    if (!r || JSON.stringify(r.job) !== JSON.stringify(job)) throw new Error('attachment_denied');
    await writeAtomic(this.directory, `${job.body.attachment.id}.json`, { job, complete: false });
    r.complete = false; r.lastProgressAt = this.now();
  }); }
  async commitUnlocked(job) {
    const r = this.records.get(job.body.attachment?.id);
    if (!r || JSON.stringify(r.job) !== JSON.stringify(job)) throw new Error('attachment_denied');
    if (!r.complete) { await this.verify(r); await writeAtomic(this.directory, `${job.body.attachment.id}.json`, { job, complete: true }); r.complete = true; }
  }
  get(id, index) { return this.serialized(() => this.getUnlocked(id, index)); }
  async getUnlocked(id, index) {
    const r = this.records.get(id);
    if (!r?.complete || r.job.body.expiresAt <= this.now()) throw new Error('attachment_denied');
    const v = await this.json(`${id}-${index}.json`, 48 * 1024); this.decode(r, index, v.cipher); return v.cipher;
  }
  remove(id) { return this.serialized(() => this.removeUnlocked(id)); }
  async removeUnlocked(id) {
    const r = this.records.get(id); if (!r) return;
    // Delete metadata last: any crash during cleanup remains recoverable. A
    // tombstone distinguishes cleanup from corruption of a committed upload.
    await writeAtomic(this.directory, `${id}.json`, { job: r.job, complete: false, deleting: true });
    r.deleting = true; r.complete = false;
    for (const index of r.parts) await removeAtomic(this.directory, `${id}-${index}.json`);
    await removeAtomic(this.directory, `${id}.json`); this.records.delete(id);
  }
  sweep() { return this.serialized(() => this.sweepUnlocked()); }
  async sweepUnlocked() { for (const [id, r] of this.records) if (r.deleting || r.job.body.expiresAt <= this.now() ||
    !r.complete && this.now() - r.lastProgressAt >= UPLOAD_IDLE_MS) await this.removeUnlocked(id); }
}
