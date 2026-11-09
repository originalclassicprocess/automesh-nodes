// Deployment smoke check: no pairing, no persistent profile, no queue writes.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import { accountIdFromPublicKey, registrationProofBytes, NODE_PROTOCOL, COURIER_PROTOCOL } from '../packages/protocol/src/index.js';
import { deploymentDefaults, httpsOrigin } from '../packages/deployment/src/defaults.js';

const origin = process.argv[2];
const appOrigin = httpsOrigin(process.argv[3] || deploymentDefaults.appOrigin);
const url = new URL(origin);
if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('https_origin_required');
const get = (path, options) => fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(10000), ...options });
const infoResponse = await get('/node/info'); assert.equal(infoResponse.status, 200);
const info = await infoResponse.json(); assert.equal(info.protocol, NODE_PROTOCOL); assert.equal(info.role, 'server');
assert.equal(info.fileQueue.maxFileBytes, 20 * 1024 * 1024);
for (const path of ['/status', '/pair-code', '/qr/pair', '/config.json', '/package.json', '/build.json', '/app.cjs', '/.automesh-node-private/master.key'])
  assert.equal((await get(path)).status, 404, `public private path ${path}`);
assert.equal((await get('/node/info', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
const cors = await get('/node/info', { headers: { Origin: appOrigin } });
assert.equal(cors.status, 200); assert.equal(cors.headers.get('access-control-allow-origin'), appOrigin);
const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
const rawKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey));
const address = await accountIdFromPublicKey(rawKey, webcrypto.subtle);
const ws = new WebSocket(origin.replace('https:', 'wss:') + '/signal', { headers: { Origin: appOrigin },
  handshakeTimeout: 10000, perMessageDeflate: false, followRedirects: false });
try {
  await new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('signed_wss_timeout')), 12000);
    const fail = error => { clearTimeout(timer); no(error); };
    ws.once('error', fail); ws.once('close', () => fail(new Error('signed_wss_closed')));
    ws.once('open', () => ws.send(JSON.stringify({ type: 'register', address })));
    ws.on('message', async value => {
      try {
        const msg = JSON.parse(value.toString());
        if (msg.type === 'register_challenge') {
          assert.equal(msg.address, address);
          const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, registrationProofBytes(address, msg.challenge))).toString('hex');
          ws.send(JSON.stringify({ type: 'register_proof', address, publicKey: Buffer.from(rawKey).toString('hex'), signature }));
        } else if (msg.type === 'registered') {
          assert.equal(msg.address, address); assert.equal(msg.courierProtocol, COURIER_PROTOCOL); clearTimeout(timer); yes();
        } else if (msg.type === 'error') fail(new Error('signed_wss_rejected'));
      } catch (error) { fail(error); }
    });
  });
} finally { ws.terminate(); }
console.log(JSON.stringify({ https: 'verified', nodeInfo: 'ok', publicPrivatePaths: 'denied', cors: 'restricted', signedWss: 'ok', persistentWrites: 0 }));
