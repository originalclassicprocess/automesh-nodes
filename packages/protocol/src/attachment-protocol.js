// Shared, versioned delivery contract. File size is a policy, not a wire integer
// or a reason to change MAE. A future increase must update storage/memory policy
// and negotiate the smaller sender/recipient/node limit, never trust peer limits.
export const ATTACHMENT_PROTOCOL = 'automesh-attachment-v1';
export const FILE_POLICY_BYTES = 20 * 1024 * 1024;
// A bound on capability metadata, not a supported file size/allocation. An old
// client must still accept text prekeys from a future peer advertising 100 MiB.
export const ATTACHMENT_CAPABILITY_CEILING = 1024 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 32 * 1024;
// Storage policy, not the wire format. Operators may configure smaller limits.
export const ATTACHMENT_MAX_PENDING = 128;
export const ATTACHMENT_MAX_PER_PROFILE = 16;
export const ATTACHMENT_MAX_PENDING_CEILING = 1024;
/** @param {{maxFiles?: number, maxFilesPerProfile?: number}} value */
export function fileQueuePolicy(value = {}) {
  const maxFiles = value.maxFiles === undefined ? ATTACHMENT_MAX_PENDING : value.maxFiles;
  const maxFilesPerProfile = value.maxFilesPerProfile === undefined ? Math.min(ATTACHMENT_MAX_PER_PROFILE, maxFiles) : value.maxFilesPerProfile;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > ATTACHMENT_MAX_PENDING_CEILING ||
      !Number.isInteger(maxFilesPerProfile) || maxFilesPerProfile < 1 || maxFilesPerProfile > maxFiles) throw new Error('invalid_attachment_limits');
  return { maxFiles, maxFilesPerProfile };
}
export const attachmentLimits = () => ({ protocol: ATTACHMENT_PROTOCOL, maxFileBytes: FILE_POLICY_BYTES, chunkBytes: ATTACHMENT_CHUNK_BYTES });
/** @param {unknown} value */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {RegExp} pattern */
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
/** @param {any} value @param {number} maxFileBytes */
export function validateAttachment(value, maxFileBytes = FILE_POLICY_BYTES) {
  const a = value;
  if (!record(a) || a.protocol !== ATTACHMENT_PROTOCOL || !matches(a.id, /^[a-f0-9]{32}$/) ||
      !Number.isSafeInteger(a.size) || a.size < 0 || a.size > maxFileBytes ||
      a.chunkBytes !== ATTACHMENT_CHUNK_BYTES || a.chunks !== Math.max(1, Math.ceil(a.size / a.chunkBytes)) ||
      a.bytes !== a.size + a.chunks * 16 || !matches(a.digest, /^[a-f0-9]{64}$/) ||
      Object.keys(a).sort().join(',') !== 'bytes,chunkBytes,chunks,digest,id,protocol,size') throw new Error('invalid_attachment');
  return a;
}
/** @param {any} a @param {number} index */
export function attachmentPartBytes(a, index) {
  validateAttachment(a);
  if (!Number.isSafeInteger(index) || index < 0 || index >= a.chunks) throw new Error('invalid_attachment_part');
  return Math.min(a.chunkBytes, Math.max(0, a.size - index * a.chunkBytes)) + 16;
}
/** @param {any} value */
export function validAttachmentRequest(value) {
  const b = value?.body;
  return record(value) && record(b) && b.protocol === ATTACHMENT_PROTOCOL && matches(b.id, /^[a-f0-9]{32}$/) &&
    Number.isSafeInteger(b.index) && b.index >= 0 && b.index < Math.ceil(FILE_POLICY_BYTES / ATTACHMENT_CHUNK_BYTES) &&
    matches(b.requestId, /^[a-f0-9]{32}$/) && Number.isSafeInteger(b.expiresAt) &&
    b.expiresAt > Date.now() && b.expiresAt <= Date.now() + 60000 &&
    matches(value.publicKey, /^04[a-f0-9]{128}$/) && matches(value.signature, /^[a-f0-9]{128}$/);
}
/** @param {any} msg */
export function validAttachmentChunk(msg) {
  return record(msg) && matches(msg.id, /^[a-f0-9]{32}$/) && matches(msg.requestId, /^[a-f0-9]{32}$/) &&
    Number.isSafeInteger(msg.index) && msg.index >= 0 && msg.index < Math.ceil(FILE_POLICY_BYTES / ATTACHMENT_CHUNK_BYTES) &&
    typeof msg.cipher === 'string' && msg.cipher.length >= 22 && msg.cipher.length <= Math.ceil((ATTACHMENT_CHUNK_BYTES + 16) * 4 / 3) && /^[A-Za-z0-9_-]+$/.test(msg.cipher);
}
