import { lstat, readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export function releaseEntries(raw) {
  if (!raw || raw.platform !== 'linux-x64' || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 3000) throw new Error('invalid_release_manifest');
  const seen = new Set();
  for (const item of raw.files) {
    if (!item || typeof item.path !== 'string' || item.path.length > 240 ||
        !/^[A-Za-z0-9_@./-]+$/.test(item.path) || item.path.split('/').some(part => !part || part === '.' || part === '..') ||
        isAbsolute(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 150 * 1024 * 1024 ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || seen.has(item.path)) throw new Error('invalid_release_manifest');
    seen.add(item.path);
  }
  if (!['bin/node', 'automesh-node', 'adapters/server/main.js', 'adapters/linux/setup.mjs'].every(path => seen.has(path))) throw new Error('invalid_release_manifest');
  return raw.files;
}
export async function verifyRelease(root) {
  const path = join(root, 'release-files.json'), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) throw new Error('invalid_release_manifest');
  for (const item of releaseEntries(JSON.parse(await readFile(path, 'utf8')))) {
    const target = join(root, item.path);
    const rel = relative(root, target); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('invalid_release_manifest');
    let current = root;
    for (const part of item.path.split('/')) {
      current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('release_symlink');
    }
    const file = await lstat(target);
    if (!file.isFile() || file.size !== item.bytes || createHash('sha256').update(await readFile(target)).digest('hex') !== item.sha256) throw new Error('release_checksum_mismatch');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await verifyRelease(fileURLToPath(new URL('../../', import.meta.url))); }
  catch { process.stderr.write('Node package verification failed. Download a fresh copy; private data was not modified.\n'); process.exitCode = 1; }
}
