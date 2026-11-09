import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAccountId, decodeAccountId, nodeProofBytes, courierBytes, NODE_PROTOCOL, MAILBOX_PROTOCOL, COURIER_PROTOCOL, ATTACHMENT_PROTOCOL, attachmentLimits } from '../packages/protocol/src/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(path, entry.name)) : [resolve(path, entry.name)]))).flat();
}
test('all production imports remain inside the standalone project or declared runtime dependencies', async () => {
  for (const file of [...await files(resolve(root, 'packages')), ...await files(resolve(root, 'adapters'))].filter(file => file.endsWith('.js'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const path = relative(root, resolve(dirname(file), specifier));
        assert.ok(!path.startsWith('..') && !isAbsolute(path), `${file}: escaped import ${specifier}`);
        await readFile(resolve(dirname(file), specifier));
      } else assert.ok(specifier.startsWith('node:') || ['ws', 'qrcode'].includes(specifier), `${file}: undeclared dependency ${specifier}`);
    }
    assert.doesNotMatch(source, /\$lib|from ['"]svelte|mnemonicToSeed|fromSeed\(|localStorage|indexedDB|document\.|window\./);
  }
});
test('the wire package has no platform, filesystem, network or implicit secret dependency', async () => {
  for (const file of (await files(resolve(root, 'packages/protocol/src'))).filter(file => file.endsWith('.js'))) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /node:|process\.|Buffer\.|fetch\(|WebSocket|localStorage|indexedDB|svelte|mnemonic/);
  }
});
test('extraction does not change wire labels, request proofs or negotiated file policy', () => {
  assert.equal(NODE_PROTOCOL, 'automesh-node-v1'); assert.equal(MAILBOX_PROTOCOL, 'automesh-opaque-mailbox-v1');
  assert.equal(COURIER_PROTOCOL, 'automesh-courier-v1'); assert.equal(ATTACHMENT_PROTOCOL, 'automesh-attachment-v1');
  assert.equal(attachmentLimits().maxFileBytes, 20 * 1024 * 1024);
  assert.equal(new TextDecoder().decode(nodeProofBytes('node', 'address', 'nonce', 'POST', '/mailbox/list', 'digest')),
    '["automesh-node-v1","request-proof","node","address","nonce","POST","/mailbox/list","digest"]');
  assert.equal(new TextDecoder().decode(courierBytes('job', { id: 'example' })), '["automesh-courier-v1","job",{"id":"example"}]');
  const fingerprint = new Uint8Array(20).fill(7);
  assert.deepEqual(decodeAccountId(encodeAccountId(fingerprint)), fingerprint);
});
test('embedded signaling has no CLI entry or surprise listener', async () => {
  const source = await readFile(resolve(root, 'packages/runtime/src/signaling.js'), 'utf8');
  assert.doesNotMatch(source, /process\.argv|process\.env|pathToFileURL|console\.(log|info|warn|error)/);
});
