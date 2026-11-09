import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { readSafeFile, safeParents } from './files.js';

// The key is supplied by an OS credential, never generated during normal start
// and never stored alongside the encrypted queues/configuration.
export function credentialProtector(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_server_master_key');
  const master = Buffer.from(key); let destroyed = false;
  const check = purpose => { if (destroyed || typeof purpose !== 'string' || !/^automesh-node-[a-z0-9-]{1,80}$/.test(purpose)) throw new Error('server_secret_unavailable'); };
  return {
    protection: 'linux-credential-aes256gcm-v1',
    async protect(bytes, purpose) {
      check(purpose);
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', master, iv);
      cipher.setAAD(Buffer.from(`automesh-server-secret-v1:${purpose}`));
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    },
    async unprotect(value, purpose) {
      check(purpose);
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{38,24000}$/.test(value)) throw new Error('invalid_server_secret');
      const raw = Buffer.from(value, 'base64url');
      if (raw.length < 28 || raw.toString('base64url') !== value) throw new Error('invalid_server_secret');
      const cipher = createDecipheriv('aes-256-gcm', master, raw.subarray(0, 12));
      cipher.setAAD(Buffer.from(`automesh-server-secret-v1:${purpose}`)); cipher.setAuthTag(raw.subarray(-16));
      return Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]);
    },
    destroy() { master.fill(0); destroyed = true; }
  };
}
export async function loadServerProtector(file) {
  const bytes = await readSafeFile(file, { limit: 32 });
  try { return credentialProtector(bytes); } finally { bytes.fill(0); }
}
export async function generateMasterKey(file) {
  await safeParents(file);
  const handle = await open(file, 'wx', 0o600), key = randomBytes(32);
  try { await handle.writeFile(key); await handle.sync(); }
  finally { key.fill(0); await handle.close(); }
}
