import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile, writeFile, chmod, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { credentialProtector, loadServerProtector, generateMasterKey } from '../adapters/server/secrets.js';
import { validateServerConfig, credentialPaths } from '../adapters/server/config.js';
import { readSafeFile, acquireDataLock } from '../adapters/server/files.js';
import { initializeServer, runServer, controlRequest } from '../adapters/server/runner.js';
import { main } from '../adapters/server/main.js';
import { sealSecret, openSecret } from '../packages/runtime/src/index.js';
import { nodeProofBytes, courierBytes, registrationProofBytes, COURIER_PROTOCOL, ATTACHMENT_PROTOCOL, ATTACHMENT_CHUNK_BYTES } from '../packages/protocol/src/index.js';
import { identity, envelope, job } from './fixtures.mjs';
import { createPersonalNode, personalNodeConfig } from '../adapters/linux/personal-node.js';

const linux = { skip: process.platform !== 'linux', timeout: 20000 }, roots = [], services = [], sockets = [], children = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function config(root = resolve('test-unused')) {
  return { version: 1, dataDirectory: join(root, 'data'), publicUrl: 'https://node.example.test', listenAddress: '127.0.0.1',
    port: 3003, controlPort: 3004, allowedOrigins: ['https://automesh.space'], masterKeyFile: join(root, 'master.key'),
    tlsKeyFile: join(root, 'tls.key'), tlsCertFile: join(root, 'tls.pem'), signalingEnabled: true, maxBytes: 64 * 1024 * 1024, maxMessages: 1000 };
}
test('personal setup uses separate data/secrets, exact HTTPS policy and a distinct control port', linux, () => {
  const value = personalNodeConfig(resolve('test-unused'), 'https://node.example.test:3004', 3004);
  assert.equal(value.controlPort, 3005); assert.equal(value.listenAddress, '0.0.0.0');
  assert.ok(!value.masterKeyFile.startsWith(value.dataDirectory));
  assert.throws(() => personalNodeConfig(resolve('test-unused'), 'http://node.example.test', 3003));
  assert.throws(() => personalNodeConfig(resolve('test-unused'), 'https://node.example.test', 443));
});
test('personal setup creates private files once and never replaces a prior identity', linux, async () => {
  const f = await fixture(), root = join(f.root, 'personal');
  const options = { root, publicUrl: f.value.publicUrl, port: f.value.port, certPath: f.value.tlsCertFile, keyPath: f.value.tlsKeyFile };
  const prepared = await createPersonalNode(options);
  const key = await readFile(prepared.config.masterKeyFile), admin = await readFile(join(root, 'data/server-admin.json'));
  await readSafeFile(prepared.configPath); await readSafeFile(prepared.config.tlsKeyFile);
  await assert.rejects(createPersonalNode(options), { code: 'EEXIST' });
  assert.deepEqual(await readFile(prepared.config.masterKeyFile), key);
  assert.deepEqual(await readFile(join(root, 'data/server-admin.json')), admin);
});
test('personal setup rejects a wrong certificate before creating its directory', linux, async () => {
  const f = await fixture(), root = join(f.root, 'personal');
  await assert.rejects(createPersonalNode({ root, publicUrl: 'https://other.example.test', port: f.value.port,
    certPath: f.value.tlsCertFile, keyPath: f.value.tlsKeyFile }), /invalid_certificate/);
  await assert.rejects(readFile(join(root, 'private/master.key')), { code: 'ENOENT' });
});
async function freePort() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(yes => server.close(yes)); return port; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'automesh-server-')); roots.push(root); await chmod(root, 0o700);
  const value = config(root); value.port = await freePort(); do { value.controlPort = await freePort(); } while (value.controlPort === value.port);
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', value.tlsKeyFile,
    '-out', value.tlsCertFile, '-days', '1', '-subj', '/CN=node.example.test', '-addext', 'subjectAltName=DNS:node.example.test']);
  await chmod(value.tlsKeyFile, 0o600);
  // OpenSSL follows the caller's umask; fixtures must not depend on a
  // developer/hosting account's group-writable default (e.g. 0002).
  await chmod(value.tlsCertFile, 0o644);
  const file = join(root, 'server-config.json'); await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await generateMasterKey(value.masterKeyFile); await initializeServer(file);
  return { root, file, value, ca: await readFile(value.tlsCertFile) };
}
async function start(f) { const service = await runServer(f.file); services.push(service); return service; }
async function waitFor(check) {
  const until = Date.now() + 7000;
  while (Date.now() < until) { if (await check()) return; await new Promise(yes => setTimeout(yes, 25)); }
  throw new Error('condition_timeout');
}
function api(f, path, body, headers = {}) {
  return new Promise((yes, no) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port: f.value.port, path, servername: 'node.example.test', ca: f.ca,
      method: bytes ? 'POST' : 'GET', headers: { Host: 'node.example.test', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); yes({ status: response.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    }); req.once('error', no); req.setTimeout(5000, () => req.destroy(new Error('request_timeout'))); req.end(bytes);
  });
}
async function signed(f, who, path, body) {
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const challenge = await api(f, '/node/challenge', { address: who.address, method: 'POST', path, digest });
  assert.equal(challenge.status, 200);
  const proof = { address: who.address, publicKey: who.publicKey, challenge: challenge.body.challenge,
    signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey,
      nodeProofBytes(challenge.body.nodeId, who.address, challenge.body.challenge, 'POST', path, digest))).toString('hex') };
  const headers = { 'X-Automesh-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') };
  return { ...await api(f, path, body, headers), headers };
}
async function pair(f, who, joinMember = false) {
  const code = (await controlRequest(f.file, 'invite')).pairCode;
  assert.equal((await signed(f, who, joinMember ? '/node/join' : '/node/pair', { code })).status, 200);
}
async function sign(who, purpose, body) { return { body, publicKey: who.publicKey,
  signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey, courierBytes(purpose, body))).toString('hex') }; }
async function recipientSocket(f, who) {
  const ws = new WebSocket(`wss://127.0.0.1:${f.value.port}/signal`, { ca: f.ca, servername: 'node.example.test', headers: { Host: 'node.example.test', Origin: 'https://automesh.space' } });
  sockets.push(ws); const messages = [];
  ws.on('message', async raw => {
    const value = JSON.parse(raw.toString()); messages.push(value);
    if (value.type === 'register_challenge') ws.send(JSON.stringify({ type: 'register_proof', address: who.address, publicKey: who.publicKey,
      signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey, registrationProofBytes(who.address, value.challenge))).toString('hex') }));
  });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'register', address: who.address }));
  await waitFor(() => messages.some(message => message.type === 'registered'));
  return { ws, messages };
}

test('server protector authenticates purpose, ciphertext, key and envelope version', async () => {
  const key = randomBytes(32), p = credentialProtector(key), other = credentialProtector(randomBytes(32)), purpose = 'automesh-node-server-admin-v1';
  key.fill(0); const sealed = await sealSecret({ adminToken: 'not-a-real-token' }, purpose, p);
  assert.deepEqual(await openSecret(sealed, purpose, p), { adminToken: 'not-a-real-token' });
  assert.equal(sealed.protection, 'linux-credential-aes256gcm-v1'); assert.ok(!JSON.stringify(sealed).includes('not-a-real-token'));
  await assert.rejects(openSecret(sealed, purpose, other)); await assert.rejects(openSecret({ ...sealed, version: 2 }, purpose, p));
  await assert.rejects(p.unprotect(sealed.ciphertext, 'automesh-node-different-purpose'));
  const raw = Buffer.from(sealed.ciphertext, 'base64url'); raw[15] ^= 1;
  await assert.rejects(p.unprotect(raw.toString('base64url'), purpose));
  p.destroy(); await assert.rejects(p.protect(Buffer.from('secret'), purpose)); other.destroy();
});
test('server config rejects insecure URL/origins, unknown fields, paths and ports', () => {
  const c = config(); assert.equal(validateServerConfig(c), c);
  for (const edit of [{ publicUrl: 'http://node.example.test' }, { publicUrl: 'https://user:pw@node.example.test' },
    { publicUrl: 'https://node.example.test/path' }, { publicUrl: 'https://127.0.0.1' }, { publicUrl: 'https://node.example.test/' },
    { allowedOrigins: ['*'] }, { allowedOrigins: ['http://example.test'] }, { allowedOrigins: ['https://u:p@example.test'] },
    { masterKeyFile: join(c.dataDirectory, 'master.key') }, { tlsKeyFile: join(c.dataDirectory, 'tls.key') },
    { adminToken: 'plaintext' }, { rejectUnauthorized: false }, { listenAddress: '::' }, { controlPort: c.port }, { port: 443 },
    { maxBytes: 0 }, { maxMessages: 5001 }, { courierRelay: 'ws://node.example.test/signal' }]) assert.throws(() => validateServerConfig({ ...c, ...edit }));
  assert.equal(credentialPaths(c, resolve('credentials')).masterKeyFile, join(resolve('credentials'), 'master-key'));
  assert.throws(() => credentialPaths(c, 'relative'));
});
test('server CLI rejects data deletion without explicit confirmation', async () => {
  await assert.rejects(main(['remove', '/unused', 'mesh1example']), /invalid_server_command/);
  await assert.rejects(main(['start', '/unused', 'extra']), /invalid_server_command/);
});
test('Linux adapter refuses Windows rather than pretending Windows modes are private', { skip: process.platform === 'linux' }, async () => {
  await assert.rejects(loadServerProtector(resolve('missing.key')), /linux_required/);
});
test('private files reject exposed permissions, symlinks, hard links and writable parents', linux, async () => {
  const f = await fixture();
  await chmod(f.value.masterKeyFile, 0o644); await assert.rejects(loadServerProtector(f.value.masterKeyFile), /unsafe_server_file/);
  await chmod(f.value.masterKeyFile, 0o600);
  const link = join(f.root, 'link.key'); await symlink(f.value.masterKeyFile, link); await assert.rejects(loadServerProtector(link));
  const { link: hardlink } = await import('node:fs/promises'); await hardlink(f.value.masterKeyFile, join(f.root, 'hard.key'));
  await assert.rejects(loadServerProtector(f.value.masterKeyFile), /unsafe_server_file/);
  const plain = join(f.root, 'plain'); await writeFile(plain, 'public'); await chmod(f.root, 0o777);
  await assert.rejects(readSafeFile(plain), /unsafe_server_parent/); await chmod(f.root, 0o700);
});
test('master key generation and init never overwrite or silently replace identities', linux, async () => {
  const f = await fixture(), before = await readFile(f.value.masterKeyFile);
  await assert.rejects(generateMasterKey(f.value.masterKeyFile), { code: 'EEXIST' }); assert.deepEqual(await readFile(f.value.masterKeyFile), before);
  await assert.rejects(initializeServer(f.file), /server_already_initialized/);
  const admin = await readFile(join(f.value.dataDirectory, 'server-admin.json'), 'utf8'); assert.ok(!admin.includes('adminToken'));
  await writeFile(f.value.masterKeyFile, randomBytes(32)); await assert.rejects(runServer(f.file));
  assert.equal(await readFile(join(f.value.dataDirectory, 'server-admin.json'), 'utf8'), admin);
});
test('OS credential directory is used without fallback to readable disk keys', linux, async () => {
  const f = await fixture(), directory = join(f.root, 'credentials'); await mkdir(directory, { mode: 0o700 });
  for (const [name, source] of [['master-key', f.value.masterKeyFile], ['tls-key', f.value.tlsKeyFile], ['tls-cert', f.value.tlsCertFile]]) {
    await writeFile(join(directory, name), await readFile(source), { mode: 0o600 });
  }
  const previous = process.env.CREDENTIALS_DIRECTORY; process.env.CREDENTIALS_DIRECTORY = directory;
  try {
    const service = await start(f); assert.equal((await api(f, '/node/info')).status, 200); await service.close();
    const { unlink } = await import('node:fs/promises'); await unlink(join(directory, 'master-key'));
    await assert.rejects(runServer(f.file), { code: 'ENOENT' });
    const release = await acquireDataLock(f.value.dataDirectory); await release();
  } finally { if (previous === undefined) delete process.env.CREDENTIALS_DIRECTORY; else process.env.CREDENTIALS_DIRECTORY = previous; }
});
test('certificate hostname mismatch fails before opening ports or replacing persisted keys', linux, async () => {
  const f = await fixture(), before = await readFile(join(f.value.dataDirectory, 'server-admin.json'));
  await writeFile(f.file, JSON.stringify({ ...f.value, publicUrl: 'https://wrong.example.test' }));
  await assert.rejects(runServer(f.file), /invalid_server_certificate/);
  assert.deepEqual(await readFile(join(f.value.dataDirectory, 'server-admin.json')), before);
  assert.deepEqual((await readdir(f.value.dataDirectory)).sort(), ['.writer.lock', 'server-admin.json']);
  const release = await acquireDataLock(f.value.dataDirectory); await release();
});
test('kernel data lock excludes a second writer, even with different control ports', linux, async () => {
  const f = await fixture(), release = await acquireDataLock(f.value.dataDirectory);
  await assert.rejects(acquireDataLock(f.value.dataDirectory), /server_data_in_use/); await release();
  const service = await start(f); const other = { ...f.value, controlPort: await freePort() };
  const file = join(f.root, 'second-config.json'); await writeFile(file, JSON.stringify(other), { mode: 0o600 });
  await assert.rejects(runServer(file), /server_data_in_use/); await service.close();
  const again = await acquireDataLock(f.value.dataDirectory); await again();
});
test('HTTPS host/origin/admin boundaries, signed pairing, replay and QR', linux, async () => {
  const f = await fixture(), service = await start(f), alice = await identity();
  const info = await api(f, '/node/info'); assert.equal(info.status, 200); assert.equal(info.body.courierLanEnabled, false); assert.equal(info.body.courierInternetEnabled, true);
  assert.equal((await api(f, '/node/info', undefined, { Host: 'evil.example.test' })).status, 403);
  assert.equal((await api(f, '/node/info', undefined, { Origin: 'https://evil.example.test' })).status, 403);
  for (const path of ['/status', '/pair-code', '/members/remove']) assert.equal((await api(f, path, {})).status, 404);
  assert.equal(service.node.control.address().address, '127.0.0.1');
  const code = (await controlRequest(f.file, 'invite')).pairCode;
  const paired = await signed(f, alice, '/node/pair', { code }); assert.equal(paired.status, 200);
  assert.equal((await api(f, '/node/pair', { code }, paired.headers)).status, 403);
  const status = await controlRequest(f.file, 'status'); assert.equal(status.members.length, 1); assert.equal(status.pairCode, undefined);
  await controlRequest(f.file, 'invite'); const qr = await controlRequest(f.file, 'qr-pair'); assert.equal(qr.subarray(1, 4).toString(), 'PNG');
  await waitFor(() => service.node.courier.ready); assert.equal(service.node.courier.routes.get('local-internet').ready, true);
});
test('two profile inboxes survive restart, revocation erases only selected queues', linux, async () => {
  const f = await fixture(), service = await start(f), [alice, bob] = await Promise.all([identity(), identity()]);
  await pair(f, alice); await pair(f, bob, true);
  const a = envelope(), b = envelope();
  assert.equal((await signed(f, alice, '/mailbox/put', { ...a, recipient: alice.address })).status, 200);
  assert.equal((await signed(f, bob, '/mailbox/put', { ...b, recipient: bob.address })).status, 200);
  await service.close(); const restarted = await start(f);
  assert.equal((await signed(f, alice, '/mailbox/list', {})).body.envelopes[0].id, a.id);
  assert.equal((await signed(f, bob, '/mailbox/list', {})).body.envelopes[0].id, b.id);
  await controlRequest(f.file, 'remove', alice.address);
  assert.equal((await signed(f, alice, '/mailbox/list', {})).status, 403);
  assert.equal((await signed(f, bob, '/mailbox/list', {})).body.envelopes[0].id, b.id);
  await restarted.close(); await start(f);
  assert.equal((await signed(f, bob, '/mailbox/list', {})).body.envelopes[0].id, b.id);
});
test('public signaling delivers a queued file after restart and accepts only recipient ACK', linux, async () => {
  const f = await fixture(), service = await start(f), [alice, bob] = await Promise.all([identity(), identity()]); await pair(f, alice);
  const encrypted = randomBytes(37), attachment = { protocol: ATTACHMENT_PROTOCOL, id: randomBytes(16).toString('hex'),
    size: 21, bytes: 37, chunkBytes: ATTACHMENT_CHUNK_BYTES, chunks: 1, digest: createHash('sha256').update(encrypted).digest('hex') };
  const value = await job(service.node.courier.address, alice, bob, attachment);
  assert.equal((await signed(f, alice, '/outbox/file/start', { job: value })).status, 200);
  assert.equal((await signed(f, alice, '/outbox/file/part', { id: attachment.id, index: 0, cipher: encrypted.toString('base64url') })).status, 200);
  assert.equal((await signed(f, alice, '/outbox/put', { job: value })).status, 200);
  const forbidden = await sign(alice, 'job', { ...value.body, id: crypto.randomUUID(), lanOnly: true });
  assert.equal((await signed(f, alice, '/outbox/put', { job: forbidden })).body.error, 'courier_disabled');
  await service.close(); const restarted = await start(f), receiver = await recipientSocket(f, bob);
  await waitFor(() => receiver.messages.some(message => message.type === 'courier_delivery'));
  const delivery = receiver.messages.find(message => message.type === 'courier_delivery'); assert.equal(delivery.job.body.id, value.body.id);
  const requestBody = { protocol: ATTACHMENT_PROTOCOL, id: attachment.id, index: 0, requestId: randomBytes(16).toString('hex'), expiresAt: Date.now() + 60000, from: bob.address, to: restarted.node.courier.address };
  receiver.ws.send(JSON.stringify({ type: 'courier_file_request', to: restarted.node.courier.address, request: await sign(bob, 'attachment-request', requestBody) }));
  await waitFor(() => receiver.messages.some(message => message.type === 'courier_file_chunk'));
  assert.equal(receiver.messages.find(message => message.type === 'courier_file_chunk').cipher, encrypted.toString('base64url'));
  const receiptBody = { protocol: COURIER_PROTOCOL, from: bob.address, to: alice.address, id: value.body.id,
    digest: createHash('sha256').update(value.body.packet).digest('hex') };
  const forged = await sign(alice, 'receipt', receiptBody);
  receiver.ws.send(JSON.stringify({ type: 'courier_receipt', to: restarted.node.courier.address, id: value.body.id.replaceAll('-', ''), receipt: JSON.stringify(forged) }));
  // A following file response is a FIFO barrier: the forged receipt was
  // processed and the encrypted file is still available to its real recipient.
  const chunksBefore = receiver.messages.filter(message => message.type === 'courier_file_chunk').length;
  receiver.ws.send(JSON.stringify({ type: 'courier_file_request', to: restarted.node.courier.address,
    request: await sign(bob, 'attachment-request', { ...requestBody, requestId: randomBytes(16).toString('hex') }) }));
  await waitFor(() => receiver.messages.filter(message => message.type === 'courier_file_chunk').length > chunksBefore);
  assert.equal(restarted.node.courier.box.stats().messages, 1);
  receiver.ws.send(JSON.stringify({ type: 'courier_receipt', to: restarted.node.courier.address, id: value.body.id.replaceAll('-', ''), receipt: JSON.stringify(await sign(bob, 'receipt', receiptBody)) }));
  // Receipt persistence and attachment removal are two awaited disk operations.
  // An empty envelope queue alone is an intermediate state, not completed cleanup.
  await waitFor(() => restarted.node.courier.box.stats().messages === 0 && restarted.node.courier.attachments.stats().files === 0);
  assert.equal(restarted.node.courier.attachments.stats().files, 0);
  const receipts = await signed(f, alice, '/outbox/receipts', { ids: [value.body.id.replaceAll('-', '')] }); assert.equal(receipts.body.receipts.length, 1);
});
test('real CLI SIGTERM and SIGKILL release locks and preserve acknowledged disk writes', linux, async () => {
  const f = await fixture();
  async function launch() {
    const child = spawn(process.execPath, [resolve('adapters/server/main.js'), 'start', f.file], { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    await waitFor(() => { if (child.exitCode !== null) throw new Error('server_cli_exited'); return output.includes('"status":"started"'); }); return child;
  }
  const child = await launch(), alice = await identity(); await pair(f, alice);
  const first = envelope(); assert.equal((await signed(f, alice, '/mailbox/put', { ...first, recipient: alice.address })).status, 200);
  const killed = once(child, 'exit'); child.kill('SIGKILL'); await killed;
  const restarted = await launch(); assert.equal((await signed(f, alice, '/mailbox/list', {})).body.envelopes[0].id, first.id);
  const stopped = once(restarted, 'exit'); restarted.kill('SIGTERM'); const [code, signal] = await stopped; assert.equal(code, 0); assert.equal(signal, null);
  const writer = await acquireDataLock(f.value.dataDirectory); await writer();
});
test('failed bind cleans up locks without publishing admin secrets', linux, async () => {
  const f = await fixture(), blocker = createServer(socket => socket.destroy()); blocker.listen(f.value.port, '127.0.0.1'); await once(blocker, 'listening');
  try { await assert.rejects(runServer(f.file), { code: 'EADDRINUSE' }); }
  finally { await new Promise(yes => blocker.close(yes)); }
  const release = await acquireDataLock(f.value.dataDirectory); await release();
  assert.deepEqual((await readdir(f.value.dataDirectory)).includes('.writer.lock'), true);
});
