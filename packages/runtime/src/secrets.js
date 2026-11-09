import { dirname } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { writeAtomic } from './files.js';

export const CONFIG_PURPOSE = 'automesh-node-config-v1';
export const COURIER_PURPOSE = 'automesh-node-courier-v1';
// Platform identifier is supplied by the adapter, never a plaintext fallback.
export const PROTECTION = 'windows-dpapi-current-user';
export async function sealSecret(value, purpose, protector) {
  const protection = protectionId(protector);
  const bytes = Buffer.from(JSON.stringify(value));
  try { return { version: 1, protection, purpose, ciphertext: await protector.protect(bytes, purpose) }; }
  finally { bytes.fill(0); }
}
export async function openSecret(record, purpose, protector) {
  if (!record || record.version !== 1 || record.protection !== protectionId(protector) || record.purpose !== purpose ||
      typeof record.ciphertext !== 'string' || record.ciphertext.length > 24000 ||
      Object.keys(record).sort().join(',') !== 'ciphertext,protection,purpose,version') throw new Error('invalid_node_secret');
  const bytes = await protector.unprotect(record.ciphertext, purpose);
  try { return JSON.parse(bytes.toString('utf8')); } finally { bytes.fill(0); }
}
function protectionId(protector) {
  if (!protector || typeof protector.protect !== 'function' || typeof protector.unprotect !== 'function' ||
      typeof protector.protection !== 'string' || !/^[a-z0-9-]{3,80}$/.test(protector.protection)) throw new Error('node_secret_protection_unavailable');
  return protector.protection;
}
export async function readNodeConfig(file, protector) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error('invalid_node_configuration');
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.version === 1) return value; // Runner migrates only after exclusive port reservation.
  if (value.version !== 2 || 'adminToken' in value || 'pfxPassword' in value) throw new Error('invalid_node_configuration');
  const secrets = await openSecret(value.secrets, CONFIG_PURPOSE, protector);
  if (Object.keys(secrets).sort().join(',') !== 'adminToken,pfxPassword') throw new Error('invalid_node_secret');
  const { secrets: ignored, ...publicConfig } = value;
  return { ...publicConfig, version: 1, ...secrets };
}
export async function protectNodeConfig(file, value, protector) {
  const { adminToken, pfxPassword, version, ...publicConfig } = value;
  const secrets = await sealSecret({ adminToken, pfxPassword }, CONFIG_PURPOSE, protector);
  // Check decryptability before replacing the only usable configuration.
  await openSecret(secrets, CONFIG_PURPOSE, protector);
  await writeAtomic(dirname(file), file.split(/[\\/]/).at(-1), { ...publicConfig, version: 2, secrets });
}
