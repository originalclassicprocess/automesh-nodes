import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import WebSocket from 'ws';
import { validatePassengerConfig, readPassengerConfig } from '../adapters/passenger/config.js';
import { runPassenger, listenPrivate } from '../adapters/passenger/runner.js';
import { verifyUnixListener } from '../adapters/passenger/transport.js';
import { initializeData, requestControl } from '../adapters/server/runner.js';
import { generateMasterKey } from '../adapters/server/secrets.js';
import { acquireDataLock } from '../adapters/server/files.js';
import { nodeProofBytes, registrationProofBytes, courierBytes, COURIER_PROTOCOL, ATTACHMENT_PROTOCOL, ATTACHMENT_CHUNK_BYTES } from '../packages/protocol/src/index.js';
import { identity, envelope, job } from './fixtures.mjs';

const linux = { skip: process.platform !== 'linux', timeout: 20000 }, roots = [], services = [], sockets = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'automesh-p-')); roots.push(root); await chmod(root, 0o700);
  const probe = createServer(); await listenPrivate(probe, 0, '127.0.0.1'); const controlPort = probe.address().port;
  await new Promise(yes => probe.close(yes));
  const config = { version: 1, transport: 'tls-frontend-unix-v1', dataDirectory: join(root, 'data'), masterKeyFile: join(root, 'master.key'),
    publicUrl: 'https://node.example.test', controlPort, allowedOrigins: ['https://automesh.space'], signalingEnabled: true, maxBytes: 64 * 1024 * 1024, maxMessages: 1000 };
  const file = join(root, 'config.json'); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await generateMasterKey(config.masterKeyFile); await initializeData(config, config.masterKeyFile);
  return { root, config, file, frontend: join(root, 'frontend.sock') };
}
async function start(f, bindFrontend = server => listenPrivate(server, f.frontend)) {
  const service = await runPassenger(f.file, { bindFrontend }); services.push(service); return service;
}
const control = (f, action) => requestControl(f.config, action, undefined, f.config.masterKeyFile);
function api(f, path, body, headers = {}) {
  return new Promise((yes, no) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ socketPath: f.frontend, path, method: bytes ? 'POST' : 'GET', headers: { Host: 'node.example.test',
      ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => yes({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }); req.once('error', no); req.setTimeout(5000, () => req.destroy(new Error('request_timeout'))); req.end(bytes);
  });
}
async function signed(f, who, path, body) {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const challenge = await api(f, '/node/challenge', { address: who.address, method: 'POST', path, digest }); assert.equal(challenge.status, 200);
  const proof = { address: who.address, publicKey: who.publicKey, challenge: challenge.body.challenge,
    signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey,
      nodeProofBytes(challenge.body.nodeId, who.address, challenge.body.challenge, 'POST', path, digest))).toString('hex') };
  return api(f, path, body, { 'X-Automesh-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') });
}
async function waitFor(check) {
  const until = Date.now() + 7000;
  while (Date.now() < until) { if (await check()) return; await new Promise(yes => setTimeout(yes, 25)); }
  throw new Error('condition_timeout');
}
const sign = async (who, purpose, body) => ({ body, publicKey: who.publicKey,
  signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey, courierBytes(purpose, body))).toString('hex') });

test('managed startup isolates private listeners from the hosting listen hook', async () => {
  const entry = await readFile(new URL('../app.cjs', import.meta.url), 'utf8');
  assert.match(entry, /configure\(\{ autoInstall: false \}\)/);
  const source = await readFile(new URL('../adapters/passenger/runner.js', import.meta.url), 'utf8');
  assert.match(source, /Server\.prototype\.listen\.call/);
  await assert.rejects(runPassenger('/unused'), /managed_frontend_required/);
});
test('Passenger policy refuses plaintext identity, keys in data, unknown knobs and exposed private config', linux, async () => {
  const f = await fixture(); assert.deepEqual(validatePassengerConfig(f.config), f.config);
  for (const edit of [{ publicUrl: 'http://node.example.test' }, { transport: 'tcp' }, { testHttp: true },
    { masterKeyFile: join(f.config.dataDirectory, 'master.key') }, { allowedOrigins: ['*'] }, { controlPort: 443 }, { port: 8080 }])
    assert.throws(() => validatePassengerConfig({ ...f.config, ...edit }));
  await assert.rejects(readPassengerConfig(f.file, f.root), /passenger_private_data_in_app/);
  await chmod(f.file, 0o644); await assert.rejects(readPassengerConfig(f.file), /unsafe_server_file/);
});
test('Unix frontend still works when the hosting adapter annotates the original client address', linux, async () => {
  const f = await fixture();
  const service = await start(f, server => {
    server.address = () => '/hosting/annotation.sock';
    server.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.7' }));
    return listenPrivate(server, f.frontend);
  });
  service.node.control.address = () => '/hosting/annotation.sock';
  service.node.control.on('connection', socket => Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.7' }));
  assert.equal((await api(f, '/node/info')).status, 200);
  assert.equal((await control(f, 'status')).members.length, 0);
});
test('managed node preserves mailbox and signed file delivery through private Unix signaling after restart', linux, async () => {
  const f = await fixture(), first = await start(f), alice = await identity(), bob = await identity();
  const info = await api(f, '/node/info'); assert.equal(info.status, 200); assert.equal(info.body.role, 'server');
  assert.equal((await api(f, '/status')).status, 404);
  assert.equal((await api(f, '/node/info', undefined, { Host: 'evil.test' })).status, 403);
  assert.equal((await api(f, '/node/info', undefined, { Origin: 'https://evil.test', 'X-Forwarded-Proto': 'https' })).status, 403);
  await waitFor(() => first.node.courier.ready);
  assert.equal((await stat(join(f.config.dataDirectory, 'courier.sock'))).mode & 0o777, 0o600);
  assert.equal((await signed(f, alice, '/node/pair', { code: (await control(f, 'invite')).pairCode })).status, 200);
  await assert.rejects(start(f), /server_data_in_use/);
  const stored = envelope(); assert.equal((await signed(f, alice, '/mailbox/put', { ...stored, recipient: alice.address })).status, 200);
  const cipher = randomBytes(32), attachment = { protocol: ATTACHMENT_PROTOCOL, id: randomBytes(16).toString('hex'), size: 16,
    chunkBytes: ATTACHMENT_CHUNK_BYTES, chunks: 1, bytes: cipher.length, digest: createHash('sha256').update(cipher).digest('hex') };
  const value = await job(first.node.courier.address, alice, bob, attachment);
  assert.equal((await signed(f, alice, '/outbox/file/start', { job: value })).status, 200);
  assert.equal((await signed(f, alice, '/outbox/file/part', { id: attachment.id, index: 0, cipher: cipher.toString('base64url') })).status, 200);
  assert.equal((await signed(f, alice, '/outbox/put', { job: value })).status, 200);
  await first.close(); const restarted = await start(f);
  assert.equal((await signed(f, alice, '/mailbox/list', {})).body.envelopes[0].id, stored.id);
  const ws = new WebSocket(`ws+unix://${f.frontend}:/signal`, { headers: { Host: 'node.example.test', Origin: 'https://automesh.space' } }); sockets.push(ws);
  const messages = []; ws.on('message', async raw => {
    const msg = JSON.parse(raw.toString()); messages.push(msg);
    if (msg.type === 'register_challenge') ws.send(JSON.stringify({ type: 'register_proof', address: bob.address, publicKey: bob.publicKey,
      signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, bob.keys.privateKey, registrationProofBytes(bob.address, msg.challenge))).toString('hex') }));
  });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'register', address: bob.address }));
  await waitFor(() => messages.some(msg => msg.type === 'courier_delivery'));
  const requestBody = { protocol: ATTACHMENT_PROTOCOL, id: attachment.id, index: 0, requestId: randomBytes(16).toString('hex'), expiresAt: Date.now() + 60000,
    from: bob.address, to: restarted.node.courier.address };
  ws.send(JSON.stringify({ type: 'courier_file_request', to: restarted.node.courier.address, request: await sign(bob, 'attachment-request', requestBody) }));
  await waitFor(() => messages.some(msg => msg.type === 'courier_file_chunk'));
  assert.equal(messages.find(msg => msg.type === 'courier_file_chunk').cipher, cipher.toString('base64url'));
  const receiptBody = { protocol: COURIER_PROTOCOL, from: bob.address, to: alice.address, id: value.body.id, digest: createHash('sha256').update(value.body.packet).digest('hex') };
  ws.send(JSON.stringify({ type: 'courier_receipt', to: restarted.node.courier.address, id: value.body.id.replaceAll('-', ''), receipt: JSON.stringify(await sign(bob, 'receipt', receiptBody)) }));
  await waitFor(() => restarted.node.courier.box.stats().messages === 0);
  // Receipt persistence precedes asynchronous attachment cleanup; observe both.
  await waitFor(() => restarted.node.courier.attachments.stats().files === 0);
  assert.equal(restarted.node.courier.attachments.stats().files, 0);
  assert.equal((await control(f, 'status')).members.length, 1);
});
test('plaintext TCP frontend is refused and failed startup releases the lock and control reservation', linux, async () => {
  const f = await fixture();
  await assert.rejects(start(f, server => listenPrivate(server, 0, '127.0.0.1')), /managed_unix_socket_required/);
  const release = await acquireDataLock(f.config.dataDirectory); await release();
  const probe = createServer(); await listenPrivate(probe, f.config.controlPort, '127.0.0.1'); await new Promise(yes => probe.close(yes));
  await start(f);
});
test('a decorated HTTP address cannot disguise a TCP listener as a Unix transport', linux, async () => {
  const f = await fixture();
  await assert.rejects(start(f, server => {
    server.address = () => '/fake-unix.sock';
    return listenPrivate(server, 0, '127.0.0.1');
  }), /managed_unix_socket_required/);
});
test('kernel-backed proof recognizes an inherited Unix fd and refuses an inherited TCP fd', linux, async () => {
  const f = await fixture(), unix = createServer(), tcp = createServer();
  const path = join(f.root, 'inherited.sock');
  await listenPrivate(unix, path); await listenPrivate(tcp, 0, '127.0.0.1');
  try {
    assert.equal(await verifyUnixListener(unix, '/fake'), true);
    assert.equal(await verifyUnixListener(tcp, path), false);
    const module = new URL('../adapters/passenger/transport.js', import.meta.url).href;
    const code = `import {createServer} from 'node:http';import {Server} from 'node:net';import {verifyUnixListener,verifyInheritedUnixDescriptor} from ${JSON.stringify(module)};
      console.log(await verifyInheritedUnixDescriptor(${JSON.stringify(path)}));
      const server=createServer();await new Promise((yes,no)=>{server.once('error',no);Server.prototype.listen.call(server,{fd:0},yes);});
      console.log(await verifyUnixListener(server,${JSON.stringify(path)}));await new Promise(yes=>server.close(yes));`;
    async function check(parent) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: [parent._handle.fd, 'pipe', 'pipe'] });
      let output = '', errors = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const [exit] = await once(child, 'exit'); assert.equal(exit, 0, errors); return output.trim(); }
      finally { clearTimeout(timer); }
    }
    assert.equal(await check(unix), 'true\ntrue'); assert.equal(await check(tcp), 'false\nfalse');
  } finally { await new Promise(yes => unix.close(yes)); await new Promise(yes => tcp.close(yes)); }
});
test('startup never deletes a file masquerading as its stale courier socket', linux, async () => {
  const f = await fixture(), path = join(f.config.dataDirectory, 'courier.sock');
  await writeFile(path, 'keep me', { mode: 0o600 });
  await assert.rejects(start(f), /unsafe_courier_socket/); assert.equal(await readFile(path, 'utf8'), 'keep me');
  const release = await acquireDataLock(f.config.dataDirectory); await release();
});
