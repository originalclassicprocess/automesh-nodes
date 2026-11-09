import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifySharedPackage } from '../scripts/verify-shared-package.mjs';
test('fresh shared package detects edits, missing files, extra files and traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'automesh-shared-check-'));
  try {
    const bytes = Buffer.from('public program fixture'), item = { path: 'app.cjs', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const manifest = { version: '0.4.4', transport: 'tls-frontend-unix-v1', files: [item] };
    const save = () => writeFile(join(root, 'release-files.json'), JSON.stringify(manifest));
    await writeFile(join(root, 'app.cjs'), bytes); await save();
    assert.equal((await verifySharedPackage(root)).verified, true);
    await writeFile(join(root, 'app.cjs'), 'modified'); await assert.rejects(verifySharedPackage(root), /shared_checksum/);
    await writeFile(join(root, 'app.cjs'), bytes); await writeFile(join(root, 'extra.txt'), 'not in manifest');
    await assert.rejects(verifySharedPackage(root), /shared_unexpected_file/); await rm(join(root, 'extra.txt'));
    manifest.files.push({ ...item, path: '../escape' }); await save(); await assert.rejects(verifySharedPackage(root), /shared_manifest_path/);
    manifest.files.pop(); await save(); await rm(join(root, 'app.cjs')); await assert.rejects(verifySharedPackage(root), /shared_missing_file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
