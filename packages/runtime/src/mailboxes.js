import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DiskMailbox } from './mailbox.js';

// One node, isolated per-account queues, one aggregate disk quota.
// The original owner's queue keeps its old directory; no destructive migration.
export class Mailboxes {
  constructor(directory, primary, state, options) {
    this.directory = directory; this.primary = primary; this.state = state;
    this.options = options; this.boxes = new Map();
  }
  async initialize() {
    for (const member of this.state.value.members) await this.get(member.address);
    if (this.stats().bytes > this.options.maxBytes) throw new Error('mailbox_disk_limit');
    return this;
  }
  async get(address) {
    if (!this.state.value.members.some(member => member.address === address)) throw new Error('not_member');
    return this.load(address);
  }
  async load(address) {
    if (address === this.state.value.primaryAddress) return this.primary;
    if (!this.boxes.has(address)) {
      const name = createHash('sha256').update(address).digest('hex');
      this.boxes.set(address, await new DiskMailbox(join(this.directory, 'boxes', name), this.options).initialize());
    }
    return this.boxes.get(address);
  }
  async remove(address) {
    const box = await this.load(address);
    await box.removeWhere(() => true);
    this.boxes.delete(address);
  }
  all() { return [this.primary, ...this.boxes.values()]; }
  stats() {
    return this.all().reduce((result, box) => {
      const next = box.stats(); result.messages += next.messages; result.bytes += next.bytes; return result;
    }, { messages: 0, bytes: 0, maxBytes: this.options.maxBytes });
  }
  // Caller serializes node operations, so quota checks across queues cannot race.
  async put(address, sender, value) {
    const box = await this.get(address); const others = this.stats().bytes - box.stats().bytes;
    box.maxBytes = Math.max(0, this.options.maxBytes - others);
    try { return await box.put(sender, value); }
    finally { box.maxBytes = this.options.maxBytes; }
  }
}
