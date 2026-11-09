import { encodeAccountId } from './bech32m.js';

// Shared by the browser and the signaling server so the fingerprint cannot drift.
const domain = new TextEncoder().encode('MeshAutonomy/account/v1\0P-256\0');

/** @param {Uint8Array} publicKey @param {SubtleCrypto} subtle */
export async function accountIdFromPublicKey(publicKey, subtle = crypto.subtle) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 65 || publicKey[0] !== 4)
    throw new Error('invalid_public_key');
  const input = new Uint8Array(domain.length + publicKey.length);
  input.set(domain);
  input.set(publicKey, domain.length);
  const hash = await subtle.digest('SHA-256', input);
  return encodeAccountId(new Uint8Array(hash).slice(0, 20));
}
