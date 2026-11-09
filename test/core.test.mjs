import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, unlink, readdir, mkdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { DiskMailbox, DiskAttachments, Courier, createNodeService, sealSecret, openSecret, NodeAuth, NodeState } from '../packages/runtime/src/index.js';
import { COURIER_PURPOSE } from '../packages/runtime/src/secrets.js';
import { ATTACHMENT_PROTOCOL, ATTACHMENT_CHUNK_BYTES, MAX_MAIL_TTL_MS, nodeProofBytes, courierBytes, COURIER_PROTOCOL } from '../packages/protocol/src/index.js';
import { identity, protector, envelope, job } from './fixtures.mjs';

const directories = [], services = [];
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'automesh-node-core-')); directories.push(path); return path; };
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function attachmentStore(size = ATTACHMENT_CHUNK_BYTES + 1) {
  const path = await directory(), chunks = Math.max(1, Math.ceil(size / ATTACHMENT_CHUNK_BYTES));
  const parts = Array.from({ length: chunks }, (_, i) => randomBytes(Math.min(ATTACHMENT_CHUNK_BYTES, Math.max(0, size - i * ATTACHMENT_CHUNK_BYTES)) + 16));
  const attachment = { protocol: ATTACHMENT_PROTOCOL, id: randomBytes(16).toString('hex'), size, chunkBytes: ATTACHMENT_CHUNK_BYTES, chunks,
    bytes: size + chunks * 16, digest: createHash('sha256').update(Buffer.concat(parts)).digest('hex') };
  const value = { body: { from: 'sender', to: 'recipient', expiresAt: Date.now() + 60000, attachment } };
  const store = await new DiskAttachments(path, 64 * 1024 * 1024).initialize();
  await store.start(value); return { path, store, attachment, value, parts: parts.map(p => p.toString('base64url')) };
}
test('recipient can pull a fair queue without signaling; pulls do not delete or expose other recipients', async () => {
  const courier = await new Courier(await directory(), { maxBytes: 64 * 1024 * 1024, secretProtector: protector(), localInternetEnabled: true }).initialize();
  services.push(courier);
  const [sender, recipient, other] = await Promise.all([identity(), identity(), identity()]);
  for (let i = 0; i < 11; i++) await courier.put(sender.address, await job(courier.address, sender, recipient));
  await courier.put(sender.address, await job(courier.address, sender, other));
  const first = await courier.inbox(recipient.address, {}, 'internet');
  assert.equal(first.deliveries.length, 8); assert.ok(first.cursor);
  const second = await courier.inbox(recipient.address, { cursor: first.cursor }, 'internet');
  assert.equal(second.deliveries.length, 3); assert.equal(second.cursor, '');
  assert.equal(new Set([...first.deliveries, ...second.deliveries].map(d => d.job.body.id)).size, 11);
  assert.ok(first.deliveries.every(d => d.job.body.to === recipient.address && d.hop.body.courier === courier.address));
  assert.equal(courier.stats(sender.address).messages, 12);
  assert.equal((await courier.inbox(other.address, {}, 'internet')).deliveries.length, 1);
  courier.authorize = () => false;
  assert.equal((await courier.inbox(recipient.address, {}, 'internet')).deliveries.length, 0);
});

test('signed HTTP inbox works with both clients absent from signaling, isolates membership and ACK ownership', async () => {
  const hosts = ['127.0.0.1:0'], service = await createNodeService({ directory: await directory(), hosts,
    origins: ['http://localhost:5173'], adminToken: 'b'.repeat(64), secretProtector: protector(), testHttp: true, localRouteScope: 'internet' });
  services.push(service);
  const listener = service.createPublicServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  hosts.push('127.0.0.1:' + listener.address().port); const url = 'http://' + hosts[1];
  const [sender, recipient, outsider] = await Promise.all([identity(), identity(), identity()]);
  await service.state.change(s => { s.owner = { address: sender.address, publicKey: sender.publicKey };
    s.members = [sender, recipient].map(who => ({ address: who.address, publicKey: who.publicKey, senders: [] })); });
  const signedValue = async (who, purpose, body) => ({ body, publicKey: who.publicKey,
    signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey, courierBytes(purpose, body))).toString('hex') });
  const api = async (who, path, value = {}) => {
    const body = JSON.stringify(value), challenge = await (await fetch(url + '/node/challenge', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: who.address, method: 'POST', path, digest: createHash('sha256').update(body).digest('hex') }) })).json();
    const proof = { address: who.address, publicKey: who.publicKey, challenge: challenge.challenge,
      signature: Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey,
        nodeProofBytes(challenge.nodeId, who.address, challenge.challenge, 'POST', path, createHash('sha256').update(body).digest('hex')))).toString('hex') };
    return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Automesh-Proof': Buffer.from(JSON.stringify(proof)).toString('base64url') }, body });
  };
  const value = await job(service.courier.address, sender, recipient);
  assert.equal((await api(sender, '/outbox/put', { job: value })).status, 200);
  assert.equal((await api(outsider, '/inbox/list')).status, 403);
  assert.equal((await api(sender, '/inbox/list')).status, 200);
  assert.equal((await (await api(sender, '/inbox/list')).json()).deliveries.length, 0);
  const pulled = await (await api(recipient, '/inbox/list')).json(); assert.equal(pulled.deliveries.length, 1);
  assert.equal(service.courier.stats(sender.address).messages, 1);
  const receipt = JSON.stringify(await signedValue(recipient, 'receipt', { protocol: COURIER_PROTOCOL,
    from: recipient.address, to: sender.address, id: value.body.id, digest: createHash('sha256').update(value.body.packet).digest('hex') }));
  const ack = { id: value.body.id.replaceAll('-', ''), receipt };
  assert.notEqual((await api(sender, '/inbox/ack', { ...ack, from: recipient.address })).status, 200);
  assert.equal(service.courier.stats(sender.address).messages, 1);
  assert.equal((await api(recipient, '/inbox/ack', ack)).status, 200);
  assert.equal((await api(recipient, '/inbox/ack', ack)).status, 200);
  assert.equal((await (await api(recipient, '/inbox/list')).json()).deliveries.length, 0);
  const cancellable=await job(service.courier.address,sender,recipient);
  assert.equal((await api(sender,'/outbox/put',{job:cancellable})).status,200);
  assert.equal((await api(outsider,'/outbox/cancel',{job:cancellable})).status,403);
  assert.notEqual((await api(recipient,'/outbox/cancel',{job:cancellable})).status,200);
  assert.equal((await (await api(sender,'/outbox/cancel',{job:cancellable})).json()).status,'canceled');
  const ids=[cancellable.body.id.replaceAll('-','')];
  assert.equal((await (await api(sender,'/outbox/outcomes',{ids})).json()).outcomes[0].status,'canceled');
  assert.deepEqual((await (await api(recipient,'/outbox/outcomes',{ids})).json()).outcomes,[]);
  assert.equal((await (await api(sender,'/outbox/put',{job:cancellable})).json()).status,'canceled');
  const scoped = await signedValue(sender, 'job', { ...(await job(service.courier.address, sender, recipient)).body, lanOnly: true });
  assert.equal((await api(sender, '/outbox/put', { job: scoped })).status, 400);
  // A previously stored LAN-only envelope must not leak through the new
  // Internet endpoint either (e.g. after changing node transport roles).
  await service.courier.box.put(sender.address, { protocol: 'automesh-opaque-mailbox-v1', id: scoped.body.id.replaceAll('-', ''),
    expiresAt: scoped.body.expiresAt, ciphertext: Buffer.from(JSON.stringify(scoped)).toString('base64url') });
  assert.equal((await (await api(recipient, '/inbox/list')).json()).deliveries.length, 0);
  assert.equal(service.courier.stats(sender.address).messages, 1);
});

test('lost deposit/ACK responses are idempotent across restart', async () => {
  const path = await directory(), first = envelope(), store = await new DiskMailbox(path).initialize();
  await Promise.all(Array.from({ length: 12 }, () => store.put('sender', first)));
  assert.equal(store.stats().messages, 1);
  let reopened = await new DiskMailbox(path).initialize();
  assert.deepEqual(await reopened.put('sender', first), { id: first.id, status: 'stored' });
  await reopened.acknowledge([first.id], { [first.id]: 'signed-receipt' });
  reopened = await new DiskMailbox(path).initialize();
  assert.deepEqual(await reopened.put('sender', first), { id: first.id, status: 'acknowledged' });
  assert.equal((await reopened.receipts('sender', [first.id])).length, 1);
  assert.deepEqual(await reopened.receipts('other-sender', [first.id]), []);
});
test('TTL removes both content and receipt tombstones after restart', async () => {
  let now = Date.now(); const path = await directory(), first = envelope(now);
  const store = await new DiskMailbox(path, { now: () => now }).initialize();
  await store.put('sender', first); await store.acknowledge([first.id]); now = first.expiresAt;
  assert.equal((await new DiskMailbox(path, { now: () => now }).initialize()).stats().bytes, 0);
});
test('a corrupt committed record fails closed and is not replaced', async () => {
  const path = await directory(), first = envelope(), store = await new DiskMailbox(path).initialize();
  await store.put('sender', first); await writeFile(join(path, first.id + '.json'), '{}');
  await assert.rejects(new DiskMailbox(path).initialize(), /corrupt_mailbox/);
  assert.equal(await readFile(join(path, first.id + '.json'), 'utf8'), '{}');
});
test('only known uncommitted temporary records are discarded', async () => {
  const path = await directory(); await writeFile(join(path, '.pending-' + 'a'.repeat(32)), 'uncommitted');
  assert.equal((await new DiskMailbox(path).initialize()).stats().messages, 0);
  assert.deepEqual(await readdir(path), []);
  await writeFile(join(path, 'unknown.json'), '{}');
  await assert.rejects(new DiskMailbox(path).initialize(), /unexpected_mailbox_file/);
});
test('bounds count, TTL and replacement even with simultaneous requests', async () => {
  const path = await directory(), store = await new DiskMailbox(path, { maxMessages: 1 }).initialize();
  const results = await Promise.allSettled([store.put('sender', envelope()), store.put('other', envelope())]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const saved = (await store.list())[0];
  await assert.rejects(store.put('forged-sender', saved), /message_conflict/);
  await assert.rejects(store.put('sender', { ...envelope(), expiresAt: Date.now() + MAX_MAIL_TTL_MS + 1000 }), /invalid_envelope/);
});
test('file parts survive interruption, resume and keep exact bytes on duplicate uploads', async () => {
  const { path, store, value, attachment, parts } = await attachmentStore();
  await store.put('sender', attachment.id, 0, parts[0]);
  const reopened = await new DiskAttachments(path, store.maxBytes).initialize();
  assert.deepEqual((await reopened.start(value)).received, [0]);
  await reopened.put('sender', attachment.id, 0, parts[0]);
  await assert.rejects(reopened.put('sender', attachment.id, 0, randomBytes(ATTACHMENT_CHUNK_BYTES + 16).toString('base64url')), /attachment_conflict/);
  await assert.rejects(reopened.commit(value), /attachment_incomplete/);
  await reopened.put('sender', attachment.id, 1, parts[1]); await reopened.commit(value);
  assert.equal(await (await new DiskAttachments(path, store.maxBytes).initialize()).get(attachment.id, 1), parts[1]);
});
test('crash halfway through file cleanup finishes from a durable deletion marker', async () => {
  const { path, store, value, attachment, parts } = await attachmentStore();
  for (let i = 0; i < parts.length; i++) await store.put('sender', attachment.id, i, parts[i]);
  await store.commit(value);
  // Reproduce the persisted boundary after deletion was marked and one part removed.
  await writeFile(join(path, attachment.id + '.json'), JSON.stringify({ job: value, complete: false, deleting: true }));
  await unlink(join(path, attachment.id + '-0.json'));
  assert.equal((await new DiskAttachments(path, store.maxBytes).initialize()).stats().files, 0);
  assert.deepEqual(await readdir(path), []);
});
test('missing part of a committed file is corruption, not successful cleanup', async () => {
  const { path, store, value, attachment, parts } = await attachmentStore(4);
  await store.put('sender', attachment.id, 0, parts[0]); await store.commit(value);
  await unlink(join(path, attachment.id + '-0.json'));
  await assert.rejects(new DiskAttachments(path, store.maxBytes).initialize(), /attachment_incomplete/);
});
test('file cleanup waits for uploads and rejects writes after removal', async () => {
  const { path, store, attachment, parts } = await attachmentStore();
  await Promise.all([store.put('sender', attachment.id, 0, parts[0]), store.remove(attachment.id)]);
  await assert.rejects(store.put('sender', attachment.id, 1, parts[1]), /attachment_denied/);
  assert.deepEqual(await readdir(path), []);
});
test('courier has no implicit OS secret store or plaintext fallback', async () => {
  assert.throws(() => new Courier('unused', {}), /node_secret_protection_unavailable/);
  await assert.rejects(sealSecret({ secret: 'test' }, COURIER_PURPOSE, {}), /node_secret_protection_unavailable/);
  const storage = protector(), sealed = await sealSecret({ secret: 'test' }, COURIER_PURPOSE, storage);
  assert.equal(sealed.protection, 'test-only-aes-gcm');
  await assert.rejects(openSecret(sealed, COURIER_PURPOSE, protector()));
  await assert.rejects(openSecret(sealed, 'different-purpose', storage));
});
test('courier identity persists independently of client identities', async () => {
  const path = await directory(), storage = protector();
  let courier = await new Courier(path, { maxBytes: 1024 * 1024, secretProtector: storage }).initialize();
  const address = courier.address; await courier.close();
  courier = await new Courier(path, { maxBytes: 1024 * 1024, secretProtector: storage }).initialize();
  assert.equal(courier.address, address); await courier.close();
  const before = await readFile(join(path, 'courier-key.json'), 'utf8');
  await assert.rejects(new Courier(path, { maxBytes: 1024 * 1024, secretProtector: protector() }).initialize());
  assert.equal(await readFile(join(path, 'courier-key.json'), 'utf8'), before);
});
test('disconnected courier still expires reserved files and messages', async () => {
  const path = await directory(), courier = await new Courier(path, { maxBytes: 1024 * 1024, secretProtector: protector() }).initialize();
  const first = envelope(); await courier.box.put('sender', first);
  courier.box.records.get(first.id).expiresAt = Date.now() - 1;
  const a = await attachmentStore(0); await courier.attachments.start(a.value);
  courier.attachments.records.get(a.attachment.id).job.body.expiresAt = Date.now() - 1;
  assert.equal(courier.ready, false); await courier.flush();
  assert.equal(courier.box.stats().messages, 0); assert.equal(courier.attachments.stats().files, 0);
  await courier.close();
});
test('removing a member frees both staged files and outgoing jobs, preserves other senders', async () => {
  const path = await directory(), courier = await new Courier(path, { maxBytes: 64 * 1024 * 1024, secretProtector: protector(), lanEnabled: true }).initialize();
  const [alice, bob, recipient] = await Promise.all([identity(), identity(), identity()]);
  const a = await attachmentStore(0), value = await job(courier.address, alice, recipient, a.attachment);
  await courier.startFile(alice.address, value); await courier.attachments.put(alice.address, a.attachment.id, 0, a.parts[0]);
  await courier.put(alice.address, value); await courier.put(bob.address, await job(courier.address, bob, recipient));
  await courier.removeMember(alice.address);
  assert.equal(courier.stats(alice.address).messages, 0); assert.equal(courier.stats(alice.address).attachments.files, 0);
  assert.equal(courier.stats(bob.address).messages, 1); await courier.close();
});
test('typed proofs reject malformed fields without coercing objects', async () => {
  const who = await identity(), auth = new NodeAuth('a'.repeat(32)), body = Buffer.from('{}');
  const digest = createHash('sha256').update(body).digest('hex'), path = '/mailbox/status';
  assert.throws(() => auth.issue({ address: who.address, method: 'POST', path, digest: { toString: null } }), /invalid_challenge/);
  const { challenge } = auth.issue({ address: who.address, method: 'POST', path, digest });
  await assert.rejects(auth.verify({ address: who.address, challenge, publicKey: { toString: null }, signature: 'b'.repeat(128) }, 'POST', path, body), /unauthorized/);
});
test('failed durable state update disables further changes until restart', async () => {
  const path = await directory(), state = await new NodeState(path).initialize(), original = state.value.nodeId;
  // Force only the destination rename to fail inside this throwaway store.
  await rename(join(path, 'state.json'), join(path, 'state.backup.json'));
  await mkdir(join(path, 'state.json'));
  await assert.rejects(state.change(next => { next.nodeId = 'a'.repeat(32); }));
  assert.equal(state.failed, true); assert.equal(state.value.nodeId, original);
  let mutated = false;
  await assert.rejects(state.change(() => { mutated = true; }), /node_state_unavailable/);
  assert.equal(mutated, false);
});
test('standalone runtime creates only explicit listeners, admin rejects browser-origin access', async () => {
  const hosts = ['127.0.0.1:0'], service = await createNodeService({ directory: await directory(), hosts, origins: ['http://localhost:5173'],
    adminToken: 'b'.repeat(64), secretProtector: protector(), testHttp: true, signalingEnabled: false }); services.push(service);
  service.control.listen(0, '127.0.0.1'); await once(service.control, 'listening');
  const url = 'http://127.0.0.1:' + service.control.address().port;
  assert.equal((await fetch(url + '/status')).status, 403);
  assert.equal((await fetch(url + '/status', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64), Origin: 'http://localhost:5173' } })).status, 403);
  const response = await fetch(url + '/status', { headers: { Authorization: 'Bearer ' + 'b'.repeat(64) } });
  assert.equal(response.status, 200); assert.equal((await response.json()).memberManagement, true);
});

test('embedded WSS bind failure reaches HTTP runner without an uncaught duplicate error', async () => {
  const blocker = createServer(socket => socket.destroy()); blocker.listen(0, '127.0.0.1'); await once(blocker, 'listening');
  const port = blocker.address().port;
  const service = await createNodeService({ directory: await directory(), hosts: [`127.0.0.1:${port}`], origins: ['http://localhost:5173'],
    adminToken: 'b'.repeat(64), secretProtector: protector(), testHttp: true }); services.push(service);
  try {
    const server = service.createPublicServer();
    await assert.rejects(new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }), { code: 'EADDRINUSE' });
    await service.close();
  } finally { await new Promise(yes => blocker.close(yes)); }
});
