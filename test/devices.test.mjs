import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash, webcrypto } from 'node:crypto';
import { identity } from './fixtures.mjs';
import { DeviceDirectory } from '../packages/runtime/src/devices.js';
import { DEVICE_DIRECTORY, deviceCanonical, deviceSigningBytes, deviceObjectDigest } from '../packages/protocol/src/devices.js';
import { courierBytes } from '../packages/protocol/src/courier-protocol.js';
async function sign(who, bytes) { return Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.keys.privateKey, bytes)).toString('hex'); }
async function transport(who, purpose, body) { return { body, publicKey: who.publicKey, signature: await sign(who, deviceSigningBytes(purpose, body)) }; }
async function core(who, body, now, audience = []) {
  const record = { version: 1, id: crypto.randomUUID(), kind: 'document', author: who.address, createdAt: now, expiresAt: now + 86400000, audience, body };
  return { record, publicKey: who.publicKey, signature: await sign(who, new TextEncoder().encode('Automesh signed object v1\0' + deviceCanonical(record))) };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'automesh-device-directory-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const [alice, phone, bob, nodeKey] = await Promise.all([identity(), identity(), identity(), identity()]); let now = Date.now();
  const authority = { url: 'https://node.example', nodeId: 'a'.repeat(32), publicKey: nodeKey.publicKey }, grants = new Set([bob.address]);
  const options = { ...authority, now: () => now, maxBytes: 64 * 1024 * 1024, maxMessages: 1000,
    isOwner: owner => [alice.address, bob.address].includes(owner), allowed: (owner, sender) => owner === sender || grants.has(sender),
    grant: async (owner, sender, revoke) => { if (revoke) grants.delete(sender); else grants.add(sender); }, availableBytes: () => 64 * 1024 * 1024,
    sign: async (purpose, body) => ({ body, publicKey: nodeKey.publicKey, signature: await sign(nodeKey, courierBytes(purpose, body)) }) };
  let node = await new DeviceDirectory(directory, options).initialize();
  const certificate = await core(alice, { type: 'automesh-device-certificate-prototype-v1', device: phone.address, devicePublicKey: phone.publicKey,
    requestId: crypto.randomUUID(), requestHash: 'b'.repeat(64), label: 'Independent phone', epoch: 0, permission: 'messages', canDelegate: false }, now, [phone.address]);
  const body = { type: DEVICE_DIRECTORY, sequence: 1, previous: null, epoch: 0, primary: true, devices: [{ certificate, revokedAt: null }], directory: authority };
  const roster = await core(alice, body, now), senderPolicy = await core(bob, { ...body, devices: [] }, now);
  await node.handle('/devices/publish', alice, { roster }); await node.handle('/devices/publish', bob, { roster: senderPolicy });
  return { directory, alice, bob, phone, nodeKey, authority, certificate, roster, senderPolicy,
    get node() { return node; }, advance() { now += 1000; return now; }, restart: async () => { node = await new DeviceDirectory(directory, options).initialize(); } };
}
test('device directory requires owner signatures and rejects rollback, conflicts and unbound recipients', async t => {
  const f = await fixture(t), nonce = 'e'.repeat(64);
  const result = await f.node.handle('/devices/policy', f.phone, { owner: f.alice.address, nonce });
  assert.equal(result.checkpoint.body.nonce, nonce); assert.equal(result.checkpoint.body.sequence, 1);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, f.nodeKey.keys.publicKey,
    Buffer.from(result.checkpoint.signature, 'hex'), courierBytes('device-checkpoint-v2', result.checkpoint.body)), true);
  await assert.rejects(f.node.handle('/devices/publish', f.phone, { roster: f.roster }));
  const changed = structuredClone(f.roster); changed.record.body.primary = false;
  await assert.rejects(f.node.handle('/devices/publish', f.alice, { roster: changed }));
  await assert.rejects(f.node.handle('/devices/receipts', f.bob, { owner: f.alice.address, device: f.bob.address, ids: [] }));
  const before = f.node.boxes.size;
  for (let i = 0; i < 4; i++) await assert.rejects(f.node.handle('/devices/receipts', f.bob, { owner: f.alice.address, device: 'invalid', ids: [] }));
  assert.equal(f.node.boxes.size, before);
  const next = await core(f.alice, { ...f.roster.record.body, sequence: 2, previous: await deviceObjectDigest(f.roster),
    devices: [{ certificate: f.certificate, revokedAt: f.advance() }] }, f.advance());
  await f.node.handle('/devices/publish', f.alice, { roster: next }); await f.restart();
  await assert.rejects(f.node.handle('/devices/list', f.phone, { owner: f.alice.address }), /device_denied/);
  await assert.rejects(f.node.handle('/devices/publish', f.alice, { roster: f.roster }), /conflict/);
});
test('one-use device prekeys, immutable mail and per-device durable signed receipts survive restart', async t => {
  const f = await fixture(t), keyId = randomBytes(16).toString('hex'), eventId = crypto.randomUUID(), expiresAt = Date.now() + 60000;
  const bundle = await transport(f.phone, 'prekeys', { protocol: DEVICE_DIRECTORY, nodeId: f.authority.nodeId, owner: f.alice.address,
    device: f.phone.address, expiresAt, keys: [{ id: keyId, publicKey: f.phone.publicKey }] });
  await f.node.handle('/devices/keys', f.phone, { owner: f.alice.address, bundle });
  const input = { owner: f.alice.address, device: f.phone.address, senderOwner: f.bob.address, senderPolicy: f.senderPolicy, eventId };
  const allocation = await f.node.handle('/devices/allocate', f.bob, input); await f.restart();
  assert.deepEqual(await f.node.handle('/devices/allocate', f.bob, input), allocation);
  await assert.rejects(f.node.handle('/devices/allocate', f.bob, { ...input, eventId: crypto.randomUUID() }), /keys_unavailable/);
  const mail = await transport(f.bob, 'mail', { protocol: DEVICE_DIRECTORY, nodeId: f.authority.nodeId, id: allocation.allocation, eventId,
    from: f.bob.address, fromOwner: f.bob.address, toOwner: f.alice.address, toDevice: f.phone.address, keyId, expiresAt,
    enc: randomBytes(65).toString('base64url'), cipher: randomBytes(32).toString('base64url') });
  assert.equal((await f.node.handle('/devices/put', f.bob, { mail })).status, 'stored'); await f.restart();
  assert.equal((await f.node.handle('/devices/list', f.alice, { owner: f.alice.address })).envelopes.length, 0);
  const envelopes = (await f.node.handle('/devices/list', f.phone, { owner: f.alice.address })).envelopes; assert.equal(envelopes.length, 1);
  const digest = createHash('sha256').update(envelopes[0].ciphertext).digest('hex');
  const receipt = await transport(f.phone, 'receipt', { nodeId: f.authority.nodeId, device: f.phone.address, sender: f.bob.address,
    id: allocation.allocation, digest, ack: 'public-test-ack' });
  await f.node.handle('/devices/ack', f.phone, { owner: f.alice.address, receipt }); await f.restart();
  await f.node.handle('/devices/ack', f.phone, { owner: f.alice.address, receipt });
  const receipts = await f.node.handle('/devices/receipts', f.bob, { owner: f.alice.address, device: f.phone.address, ids: [allocation.allocation] });
  assert.equal(receipts.receipts.length, 1);
  assert.equal((await f.node.handle('/devices/list', f.phone, { owner: f.alice.address })).envelopes.length, 0);
  assert.equal((await f.node.handle('/devices/put', f.bob, { mail })).status, 'acknowledged');
  const altered = await transport(f.bob, 'mail', { ...mail.body, cipher: randomBytes(32).toString('base64url') });
  await assert.rejects(f.node.handle('/devices/put', f.bob, { mail: altered }), /conflict/);
  await f.node.removeOwner(f.alice.address); assert.equal((await readdir(join(f.directory, 'devices-v2'))).some(name => name.endsWith('.json') && name === createHash('sha256').update(f.alice.address).digest('hex') + '.json'), false);
});
