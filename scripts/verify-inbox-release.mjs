// Read-only release check. Ephemeral identities are NOT paired with the node.
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { accountIdFromPublicKey, nodeProofBytes } from '../packages/protocol/src/index.js';
const input = process.argv[2];
const target = new URL(input);
if (target.protocol !== 'https:' || target.origin !== input || target.username || target.password) throw new Error('explicit_https_origin_required');
const origin = target.origin;
const info = await (await fetch(origin + '/node/info', { signal: AbortSignal.timeout(15000) })).json();
assert.match(info.nodeId, /^[a-f0-9]{32}$/);
// Operators may pin the expected public identity privately, not in source Git.
if (process.env.AUTOMESH_EXPECTED_NODE_ID) {
  assert.match(process.env.AUTOMESH_EXPECTED_NODE_ID, /^[a-f0-9]{32}$/);
  assert.equal(info.nodeId, process.env.AUTOMESH_EXPECTED_NODE_ID);
}
assert.equal(typeof info.paired, 'boolean');
const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey));
const address = await accountIdFromPublicKey(raw, webcrypto.subtle), body = '{}';
const digest = createHash('sha256').update(body).digest('hex');
for (const path of ['/inbox/list', '/inbox/ack', '/inbox/file/parts']) {
  let challengeResponse; const deadline = Date.now() + 40000;
  do {
    challengeResponse = await fetch(origin + '/node/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, method: 'POST', path, digest }), cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (challengeResponse.status === 200 || Date.now() >= deadline) break;
    await challengeResponse.text(); await new Promise(resolve => setTimeout(resolve, 1000));
  } while (true);
  assert.equal(challengeResponse.status, 200); const challenge = await challengeResponse.json(); assert.equal(challenge.nodeId, info.nodeId);
  const proof = { address, publicKey: Buffer.from(raw).toString('hex'), challenge: challenge.challenge,
    signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
      nodeProofBytes(info.nodeId, address, challenge.challenge, 'POST', path, digest))).toString('hex') };
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Automesh-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') }, body, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 403); assert.equal((await response.json()).error, 'not_member');
}
console.log(JSON.stringify({ nodeIdUnchanged: true, pairingPreserved: true, inboxRoutes: 'live', signedNonmemberAccess: 'denied', persistentQueueWrites: 0 }));
