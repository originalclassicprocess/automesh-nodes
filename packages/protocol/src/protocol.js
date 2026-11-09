// Shared wire format only. No storage, UI, seed or encryption dependencies.
export const NODE_PROTOCOL = 'automesh-node-v1';
export const MAILBOX_PROTOCOL = 'automesh-opaque-mailbox-v1';
export const MAX_ENVELOPE_BYTES = 128 * 1024;
export const MAX_MAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** @param {string} nodeId @param {string} address @param {string} challenge
 * @param {string} method @param {string} path @param {string} digest */
export function nodeProofBytes(nodeId, address, challenge, method, path, digest) {
  return new TextEncoder().encode(JSON.stringify([
    NODE_PROTOCOL, 'request-proof', nodeId, address, challenge, method, path, digest,
  ]));
}

/** @param {unknown} value */
export function isMessageId(value) { return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value); }

/** @param {any} value @param {number} now */
export function normalizeEnvelope(value, now = Date.now()) {
  if (!value || value.protocol !== MAILBOX_PROTOCOL || !isMessageId(value.id) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + MAX_MAIL_TTL_MS ||
      typeof value.ciphertext !== 'string' || value.ciphertext.length > Math.ceil(MAX_ENVELOPE_BYTES * 4 / 3) ||
      !/^[A-Za-z0-9_-]+$/.test(value.ciphertext)) throw new Error('invalid_envelope');
  // Base64url is canonical and bounded. The node does NOT claim it can prove
  // that these opaque bytes are encrypted; decryption/authentication is client work.
  const length = Math.floor(value.ciphertext.length * 3 / 4);
  if (length < 16 || length > MAX_ENVELOPE_BYTES || value.ciphertext.length % 4 === 1)
    throw new Error('invalid_envelope');
  return { protocol: MAILBOX_PROTOCOL, id: value.id, expiresAt: value.expiresAt, ciphertext: value.ciphertext };
}
