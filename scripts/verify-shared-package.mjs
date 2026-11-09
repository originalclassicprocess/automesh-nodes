// Verify a freshly extracted program package BEFORE creating keys/configuration.
// Integrity inventory only, not an independent publisher signature.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function verifySharedPackage(root) {
  const manifestPath = join(root, 'release-files.json'), info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('shared_manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.transport !== 'tls-frontend-unix-v1' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 3000) throw new Error('shared_manifest');
  const expected = new Set(['release-files.json']);
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !/^[A-Za-z0-9_@./-]+$/.test(item.path) || item.path.startsWith('/') ||
      item.path.split('/').some(part => !part || part === '.' || part === '..') || expected.has(item.path) ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('shared_manifest_path');
    expected.add(item.path);
  }
  const seen = new Set();
  async function walk(directory = '') {
    for (const name of await readdir(join(root, directory))) {
      const path = directory ? directory + '/' + name : name, file = join(root, path), entry = await lstat(file);
      if (entry.isSymbolicLink()) throw new Error('shared_symlink');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        if (!expected.has(path)) throw new Error('shared_unexpected_file');
        seen.add(path);
        if (path === 'release-files.json') continue;
        const item = manifest.files.find(item => item.path === path);
        if (entry.size !== item.bytes || createHash('sha256').update(await readFile(file)).digest('hex') !== item.sha256) throw new Error('shared_checksum');
      } else throw new Error('shared_file_type');
    }
  }
  await walk();
  if (seen.size !== expected.size) throw new Error('shared_missing_file');
  return { version: manifest.version, files: manifest.files.length, verified: true, signed: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifySharedPackage(fileURLToPath(new URL('../', import.meta.url))))); }
  catch { console.error('Shared node package check failed. Do not initialize; download a fresh package.'); process.exitCode = 1; }
}
