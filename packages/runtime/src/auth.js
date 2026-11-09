import { randomBytes, createHash, timingSafeEqual, webcrypto } from 'node:crypto';
import { accountIdFromPublicKey } from '../../protocol/src/account-id.js';
import { isValidAccountId } from '../../protocol/src/bech32m.js';
import { nodeProofBytes } from '../../protocol/src/protocol.js';
import { DEVICE_PATHS } from '../../protocol/src/devices.js';
import {COURIER_PREKEY_PATHS} from '../../protocol/src/courier-prekeys.js';
import {RECIPIENT_INBOX_PATHS} from '../../protocol/src/recipient-inbox.js';

export class NodeAuth {
  constructor(nodeId, now = Date.now, extraPaths = []) { this.nodeId = nodeId; this.now = now; this.challenges = new Map(); this.extraPaths = extraPaths; }
  issue(value) {
    for (const [token, item] of this.challenges) if (item.expiresAt <= this.now()) this.challenges.delete(token);
    if (this.challenges.size >= 256) throw new Error('too_many_challenges');
    if (!value || !isValidAccountId(value.address) || value.method !== 'POST' ||
        !['/node/pair', '/node/join', '/mailbox/put', '/mailbox/list', '/mailbox/receipts', '/mailbox/ack', '/mailbox/grant', '/mailbox/revoke', '/mailbox/status',
          '/outbox/put', '/outbox/status', '/outbox/list', '/outbox/receipts', '/outbox/outcomes', '/outbox/cancel', '/outbox/route', '/outbox/file/start', '/outbox/file/part', '/outbox/file/cancel',
          '/inbox/list', '/inbox/ack', '/inbox/file/parts', ...RECIPIENT_INBOX_PATHS, ...COURIER_PREKEY_PATHS, ...DEVICE_PATHS, ...this.extraPaths].includes(value.path) ||
        typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('invalid_challenge');
    const challenge = randomBytes(32).toString('hex');
    this.challenges.set(challenge, { address: value.address, method: value.method, path: value.path, digest: value.digest, expiresAt: this.now() + 30_000 });
    return { nodeId: this.nodeId, challenge, expiresAt: this.now() + 30_000 };
  }
  async verify(proof, method, path, body) {
    if (!proof || typeof proof.challenge !== 'string') throw new Error('unauthorized');
    const item = this.challenges.get(proof.challenge);
    this.challenges.delete(proof.challenge); // consumed BEFORE async verification
    if (!item || item.expiresAt <= this.now() || item.address !== proof.address || item.method !== method || item.path !== path ||
        item.digest !== createHash('sha256').update(body).digest('hex') ||
        typeof proof.publicKey !== 'string' || typeof proof.signature !== 'string' ||
        !/^04[a-f0-9]{128}$/.test(proof.publicKey) || !/^[a-f0-9]{128}$/.test(proof.signature)) throw new Error('unauthorized');
    const publicBytes = new Uint8Array(Buffer.from(proof.publicKey, 'hex'));
    if (await accountIdFromPublicKey(publicBytes, webcrypto.subtle) !== proof.address) throw new Error('unauthorized');
    try {
      const key = await webcrypto.subtle.importKey('raw', publicBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
        Buffer.from(proof.signature, 'hex'), nodeProofBytes(this.nodeId, proof.address, proof.challenge, method, path, item.digest))) throw new Error('unauthorized');
    } catch { throw new Error('unauthorized'); }
    return { address: proof.address, publicKey: proof.publicKey };
  }
}
export function equalToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
