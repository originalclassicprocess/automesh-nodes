// Tests only: an ephemeral key, not a production secret-store adapter.
import { randomBytes, createCipheriv, createDecipheriv, webcrypto } from 'node:crypto';
import { accountIdFromPublicKey, courierBytes, COURIER_PROTOCOL, MAILBOX_PROTOCOL } from '../packages/protocol/src/index.js';

export function protector() {
  const key = randomBytes(32);
  return { protection: 'test-only-aes-gcm',
    async protect(bytes, purpose) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(purpose));
      return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    async unprotect(value, purpose) {
      const raw = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      cipher.setAAD(Buffer.from(purpose)); cipher.setAuthTag(raw.subarray(-16));
      return Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]);
    }
  };
}
export async function identity() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const bytes = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey));
  return { keys, publicKey: Buffer.from(bytes).toString('hex'), address: await accountIdFromPublicKey(bytes, webcrypto.subtle) };
}
export const envelope = (now = Date.now()) => ({ protocol: MAILBOX_PROTOCOL, id: randomBytes(16).toString('hex'), expiresAt: now + 60000, ciphertext: randomBytes(64).toString('base64url') });
export async function job(courier, from, to, attachment) {
  const body = { protocol: COURIER_PROTOCOL, courier, from: from.address, to: to.address, id: crypto.randomUUID(),
    packet: randomBytes(64).toString('base64url'), expiresAt: Date.now() + 60000, ...(attachment ? { attachment } : {}) };
  return { body, publicKey: from.publicKey,
    signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, from.keys.privateKey, courierBytes('job', body))).toString('hex') };
}
