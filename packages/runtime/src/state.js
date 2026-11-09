import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isValidAccountId } from '../../protocol/src/bech32m.js';
import { privateDirectory, writeAtomic } from './files.js';

export class NodeState {
  constructor(directory) { this.directory = directory; this.chain = Promise.resolve(); }
  async initialize() {
    await privateDirectory(this.directory);
    try {
      const file = join(this.directory, 'state.json'); const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error('corrupt_node_state');
      this.value = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.value = { version: 1, nodeId: randomBytes(16).toString('hex'), owner: null, senders: [], members: [] };
      await writeAtomic(this.directory, 'state.json', this.value);
    }
    const state = this.value;
    if (state.version !== 1 || !/^[a-f0-9]{32}$/.test(state.nodeId) || (state.panelInitialized !== undefined && state.panelInitialized !== true) ||
        (state.owner !== null && (!isValidAccountId(state.owner?.address) || !/^04[a-f0-9]{128}$/.test(state.owner?.publicKey))) ||
        !Array.isArray(state.senders) || state.senders.length > 50 || state.senders.some(id => !isValidAccountId(id))) throw new Error('corrupt_node_state');
    let migrated = false;
    if (state.members === undefined) {
      state.members = state.owner ? [{ ...state.owner, senders: [...state.senders] }] : [];
      migrated = true;
    }
    if (!Array.isArray(state.members) || state.members.length > 8 ||
        new Set(state.members.map(member => member?.address)).size !== state.members.length ||
        state.members.some(member => !isValidAccountId(member?.address) || !/^04[a-f0-9]{128}$/.test(member.publicKey) ||
          !Array.isArray(member.senders) || member.senders.length > 50 || member.senders.some(id => !isValidAccountId(id))) ||
        (state.owner && !state.members.some(member => member.address === state.owner.address && member.publicKey === state.owner.publicKey)) ||
        (!state.owner && state.members.length)) throw new Error('corrupt_node_state');
    if (state.primaryAddress === undefined) { state.primaryAddress = state.owner?.address ?? null; migrated = true; }
    if (state.pendingRemovals === undefined) { state.pendingRemovals = []; migrated = true; }
    if ((state.primaryAddress !== null && !isValidAccountId(state.primaryAddress)) || (state.members.length && !state.primaryAddress) ||
        !Array.isArray(state.pendingRemovals) || state.pendingRemovals.length > 8 ||
        state.pendingRemovals.some(address => !isValidAccountId(address) || state.members.some(member => member.address === address)) ||
        new Set(state.pendingRemovals).size !== state.pendingRemovals.length) throw new Error('corrupt_node_state');
    if (migrated) await writeAtomic(this.directory, 'state.json', state);
    return this;
  }
  change(work) {
    const result = this.chain.then(async () => {
      if (this.failed) throw new Error('node_state_unavailable');
      const next = structuredClone(this.value); await work(next);
      try { await writeAtomic(this.directory, 'state.json', next); }
      catch (error) { this.failed = true; throw error; }
      this.value = next;
    });
    this.chain = result.catch(() => {}); return result;
  }
}
