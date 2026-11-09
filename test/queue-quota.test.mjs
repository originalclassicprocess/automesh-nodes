import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { DiskAttachments, DiskMailbox, Courier, createNodeService } from '../packages/runtime/src/index.js';
import { ATTACHMENT_PROTOCOL, ATTACHMENT_CHUNK_BYTES, fileQueuePolicy, nodeProofBytes } from '../packages/protocol/src/index.js';
import { UPLOAD_IDLE_MS, queueLimit } from '../packages/runtime/src/queue-quota.js';
import { validateServerConfig } from '../adapters/server/config.js';
import { validatePassengerConfig } from '../adapters/passenger/config.js';
import { validateNodeConfig } from '../adapters/windows/runner.js';
import { identity, protector, job, envelope } from './fixtures.mjs';

const paths = [], services = [], MB = 1024 * 1024;
const directory = async () => { const p = await mkdtemp(join(tmpdir(), 'automesh-quota-')); paths.push(p); return p; };
afterEach(async () => { for (const s of services.splice(0)) await s.close(); for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true }); });
function file(from = 'sender', now = Date.now()) {
  const part = randomBytes(17), attachment = { protocol: ATTACHMENT_PROTOCOL, id: randomBytes(16).toString('hex'),
    size: 1, bytes: 17, chunks: 1, chunkBytes: ATTACHMENT_CHUNK_BYTES, digest: createHash('sha256').update(part).digest('hex') };
  return { value: { body: { from, to: 'recipient', expiresAt: now + 2 * UPLOAD_IDLE_MS, attachment } }, attachment, part: part.toString('base64url') };
}
const limit = reason => error => error.message === 'mailbox_full' && error.limit === reason;

test('default file capacity exceeds 16 while an originating profile cannot exhaust all slots', async () => {
  const store = await new DiskAttachments(await directory(), 64 * MB).initialize();
  const first = file(); await store.start(first.value);
  for (let n = 1; n < 16; n++) await store.start(file().value);
  await assert.rejects(store.start(file().value), limit('profile_files'));
  await store.start(file('other').value);
  assert.equal(store.stats().files, 17);
  assert.equal(store.stats().maxFiles, 128);
  const reopened = await new DiskAttachments(store.directory, 64 * MB, { maxFiles: 2, maxFilesPerProfile: 1 }).initialize();
  assert.equal(reopened.stats().files, 17); // lowering quota never evicts old mail
  assert.deepEqual(await reopened.start(first.value), { received: [], complete: false });
  await assert.rejects(reopened.start(file('new').value), limit('node_files'));
});

test('global file count and storage quota give different reasons', async () => {
  const store = await new DiskAttachments(await directory(), 64 * MB, { maxFiles: 2, maxFilesPerProfile: 2 }).initialize();
  await store.start(file('one').value); await store.start(file('two').value);
  await assert.rejects(store.start(file('three').value), limit('node_files'));
  const small = await new DiskAttachments(await directory(), 8192).initialize();
  await assert.rejects(small.start(file().value), limit('storage'));
  assert.equal(small.stats().files, 0);
});

test('idle partial upload frees reservation; accepted chunks extend it, retries do not', async () => {
  let now = Date.now(); const path = await directory(), a = file('sender', now);
  const store = await new DiskAttachments(path, MB, { now: () => now }).initialize();
  await store.start(a.value); now += UPLOAD_IDLE_MS / 2;
  await store.put('sender', a.attachment.id, 0, a.part);
  now += UPLOAD_IDLE_MS / 2;
  await store.put('sender', a.attachment.id, 0, a.part);
  assert.equal(store.stats().files, 1);
  now += UPLOAD_IDLE_MS / 2;
  await store.sweep(); assert.equal(store.stats().bytes, 0);
  assert.deepEqual(await readdir(path), []);
});

test('restart preserves idle expiry while completed files survive until their original TTL', async () => {
  let now = Date.now(); const path = await directory(), staged = file('sender', now), complete = file('sender', now);
  let store = await new DiskAttachments(path, MB, { now: () => now }).initialize();
  await store.start(staged.value); await store.put('sender', staged.attachment.id, 0, staged.part);
  await store.start(complete.value); await store.put('sender', complete.attachment.id, 0, complete.part); await store.commit(complete.value);
  for (const name of await readdir(path)) await utimes(join(path, name), new Date(now), new Date(now));
  now += UPLOAD_IDLE_MS + 1000;
  store = await new DiskAttachments(path, MB, { now: () => now }).initialize();
  assert.equal(store.stats().files, 1); assert.equal(store.stats().uploading, 0);
  assert.equal(await store.get(complete.attachment.id, 0), complete.part);
  now = complete.value.body.expiresAt; await store.sweep(); assert.equal(store.stats().files, 0);
});

test('quota rejection after upload keeps it resumable; ambiguous disk errors retain accepted parts', async () => {
  const courier = await new Courier(await directory(), { maxBytes: 64 * MB, secretProtector: protector(), localInternetEnabled: true }).initialize(); services.push(courier);
  const [sender, recipient] = await Promise.all([identity(), identity()]), a = file();
  const value = await job(courier.address, sender, recipient, a.attachment);
  await courier.startFile(sender.address, value); await courier.attachments.put(sender.address, a.attachment.id, 0, a.part);
  const deposit = courier.box.put.bind(courier.box);
  courier.box.put = async () => { throw queueLimit('storage'); };
  await assert.rejects(courier.put(sender.address, value), limit('storage'));
  assert.equal(courier.attachments.records.get(a.attachment.id).complete, false);
  assert.deepEqual((await courier.startFile(sender.address, value)).received, [0]);
  courier.box.put = async () => { throw new Error('disk_failure'); };
  await assert.rejects(courier.put(sender.address, value), /disk_failure/);
  assert.equal(courier.attachments.records.get(a.attachment.id).complete, true);
  courier.box.put = deposit;
  await courier.put(sender.address, value);
  assert.equal(courier.stats().messages, 1);
});

test('message quotas preserve the legacy error and identify count versus byte limits', async () => {
  const store = await new DiskMailbox(await directory(), { maxMessages: 1 }).initialize();
  await store.put('one', envelope());
  await assert.rejects(store.put('two', envelope()), limit('node_messages'));
  const profile = await new DiskMailbox(await directory()).initialize();
  for (let n = 0; n < 100; n++) await profile.put('one', envelope());
  assert.equal(profile.quota('one').profileMessages,100);assert.equal(profile.quota('one').profileMessageLimit,100);
  await assert.rejects(profile.put('one', envelope()), limit('profile_messages'));
  await profile.put('two', envelope());
  profile.maxBytes = profile.stats().bytes;
  await assert.rejects(profile.put('two', envelope()), limit('storage'));
});

test('all adapters validate explicit file quotas; omission keeps existing configs valid', () => {
  assert.deepEqual(fileQueuePolicy(), { maxFiles: 128, maxFilesPerProfile: 16 });
  assert.deepEqual(fileQueuePolicy({ maxFiles: 2 }), { maxFiles: 2, maxFilesPerProfile: 2 });
  const server = { version: 1, publicUrl: 'https://node.example.test', dataDirectory: resolve('data'), masterKeyFile: resolve('master.key'),
    tlsKeyFile: resolve('tls.key'), tlsCertFile: resolve('tls.pem'), listenAddress: '127.0.0.1', port: 3003, controlPort: 3004,
    allowedOrigins: ['https://app.example.test'], signalingEnabled: true, maxBytes: 64 * MB, maxMessages: 1000 };
  const passenger = { version: 1, transport: 'tls-frontend-unix-v1', publicUrl: server.publicUrl, dataDirectory: '/home/test/data',
    masterKeyFile: '/home/test/key', controlPort: 3004, allowedOrigins: server.allowedOrigins, signalingEnabled: true, maxBytes: 64 * MB, maxMessages: 1000 };
  const windows = { version: 1, lanAddress: '192.168.1.2', dataDirectory: resolve('data'), pfxFile: resolve('tls.pfx'), pfxPassword: 'test', adminToken: 'a'.repeat(64),
    port: 3003, controlPort: 3004, maxBytes: 64 * MB };
  const validateWindows = value => validateNodeConfig(value, { test: [{ address: windows.lanAddress }] });
  for (const [config, validate] of [[server, validateServerConfig], [passenger, validatePassengerConfig], [windows, validateWindows]]) {
    // Passenger uses Linux absolute paths; its quota validation runs before
    // those platform-specific checks and can still be checked on Windows.
    if (validate !== validatePassengerConfig || process.platform === 'linux') {
      assert.equal(validate(config), config);
      assert.equal(validate({ ...config, maxFiles: 256, maxFilesPerProfile: 32 }).maxFiles, 256);
    }
    for (const edit of [{ maxFiles: 0 }, { maxFiles: 1025 }, { maxFiles: 1.5 }, { maxFiles: '128' }, { maxFiles: null },
      { maxFilesPerProfile: 0 }, { maxFilesPerProfile: 129 }, { maxFilesPerProfile: null }, { maxFiles: 2, maxFilesPerProfile: 3 }])
      assert.throws(() => validate({ ...config, ...edit }), /invalid_attachment_limits/);
  }
});

test('signed HTTP API returns an optional precise quota reason and reserves message space', async () => {
  const hosts = ['127.0.0.1:0'], service = await createNodeService({ directory: await directory(), hosts, origins: ['http://localhost:5173'],
    adminToken: 'a'.repeat(64), secretProtector: protector(), testHttp: true, localRouteScope: 'internet', maxFiles: 1, maxFilesPerProfile: 1 }); services.push(service);
  const listener = service.createPublicServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  hosts.push('127.0.0.1:' + listener.address().port); const url = 'http://' + hosts[1];
  const [sender, recipient] = await Promise.all([identity(), identity()]);
  await service.state.change(s => { s.owner = { address: sender.address, publicKey: sender.publicKey }; s.members = [sender, recipient].map(who => ({ address: who.address, publicKey: who.publicKey, senders: [] })); });
  const api = async (path, body, who=sender) => {
    const bytes = JSON.stringify(body), digest = createHash('sha256').update(bytes).digest('hex');
    const challenge = await (await fetch(url + '/node/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: who.address, method: 'POST', path, digest }) })).json();
    const proof = { address: who.address, publicKey: who.publicKey, challenge: challenge.challenge,
      signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey, nodeProofBytes(challenge.nodeId, who.address, challenge.challenge, 'POST', path, digest))).toString('hex') };
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Automesh-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') }, body: bytes });
    return { status: response.status, value: await response.json() };
  };
  const first = await job(service.courier.address, sender, recipient, file().attachment);
  const start = service.courier.startFile.bind(service.courier); let budget;
  service.courier.startFile = (...args) => { budget = service.courier.attachments.maxBytes; return start(...args); };
  assert.equal((await api('/outbox/file/start', { job: first })).status, 200);
  const capacity=(await api('/outbox/status',{})).value;
  assert.equal(capacity.quota.protocol,'automesh-queue-quota-v1');
  assert.equal(capacity.quota.profileFiles,1);assert.equal(capacity.quota.profileFileLimit,1);
  assert.equal(capacity.quota.nodeFiles,1);assert.equal(capacity.quota.nodeFileLimit,1);
  assert.equal(capacity.quota.profileMessages,0);assert.equal(capacity.quota.profileMessageLimit,100);assert.equal(capacity.quota.nodeMessageLimit,1000);
  assert.equal(capacity.messages,0); // staged upload uses a slot before an envelope is committed
  assert.equal((await api('/outbox/list',{})).value.jobs[0].body.id,first.body.id);
  assert.equal((await api('/outbox/list',{},recipient)).value.jobs.length,0);
  assert.notEqual((await fetch(url+'/outbox/list',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);

  assert.equal(budget, 56 * MB); assert.equal(service.courier.attachments.maxBytes, 64 * MB);
  const second = await job(service.courier.address, sender, recipient, file().attachment);
  const rejected = await api('/outbox/file/start', { job: second });
  assert.notEqual(rejected.status, 200);
  assert.deepEqual(rejected.value, { error: 'mailbox_full', limit: 'profile_files' });
  assert.equal((await api('/outbox/put', { job: await job(service.courier.address, sender, recipient) })).status, 200);
  assert.equal((await api('/outbox/status',{})).value.quota.profileMessages,1);assert.equal((await api('/outbox/status',{},recipient)).value.quota.profileMessages,0);
});

test('message capacity uses actual configured limits and separates retained receipts from pending messages',async()=>{
 const store=await new DiskMailbox(await directory(),{maxMessages:3,retainOutcomes:true}).initialize();
 const first=envelope();await store.put('one',first);await store.put('two',envelope());
 assert.deepEqual({...store.quota('one'),profileMessageBytes:0},{profileMessages:1,profileMessageLimit:100,profileMessageBytes:0,profileMessageByteLimit:4194304,nodeMessages:2,nodeMessageLimit:3,nodeRecords:2,nodeRecordLimit:6});
 assert.ok(store.quota('one').profileMessageBytes>0);await store.acknowledge([first.id]);
 assert.equal(store.quota('one').profileMessages,0);assert.equal(store.quota('one').profileMessageBytes,0);assert.equal(store.quota('one').nodeRecords,2);
 const reopened=await new DiskMailbox(store.directory,{maxMessages:3,retainOutcomes:true}).initialize();assert.deepEqual(reopened.quota('one'),store.quota('one'));
});
