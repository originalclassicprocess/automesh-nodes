import { readFile, writeFile, mkdir, copyFile, lstat, readdir, mkdtemp } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const release = join(root, '.release'); await mkdir(release, { recursive: true });
const stage = await mkdtemp(join(release, 'linux-'));
const runtime = JSON.parse(await readFile(join(root, 'adapters/windows/runtime.json'), 'utf8'));
const archive = join(release, `node-v${runtime.version}-linux-x64.tar.xz`);
let runtimeArchive;
try { runtimeArchive = await readFile(archive); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(runtime.linuxSource, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('linux_runtime_download_failed');
  runtimeArchive = Buffer.from(await response.arrayBuffer());
  if (runtimeArchive.length > 64 * 1024 * 1024 || createHash('sha256').update(runtimeArchive).digest('hex') !== runtime.linuxX64Sha256) throw new Error('linux_runtime_checksum_mismatch');
  await writeFile(archive, runtimeArchive, { flag: 'wx' });
}
if (createHash('sha256').update(runtimeArchive).digest('hex') !== runtime.linuxX64Sha256) throw new Error('linux_runtime_checksum_mismatch');
const extracted = spawnSync('tar', ['-xf', archive, '-C', stage, '--strip-components=1', `node-v${runtime.version}-linux-x64/bin/node`, `node-v${runtime.version}-linux-x64/LICENSE`], { windowsHide: true, encoding: 'utf8' });
if (extracted.status !== 0) throw new Error('linux_runtime_extract_failed');
const executable = await readFile(join(stage, 'bin/node'));
if (executable[0] !== 0x7f || executable.subarray(1, 4).toString() !== 'ELF' || executable[4] !== 2 || executable.readUInt16LE(18) !== 62) throw new Error('invalid_linux_x64_runtime');
await copyFile(join(stage, 'LICENSE'), join(stage, 'LICENSE-Node.txt'));
async function copyPublic(path) {
  const info = await lstat(join(root, path)); if (info.isSymbolicLink()) throw new Error('source_symlink');
  if (info.isDirectory()) {
    await mkdir(join(stage, path), { recursive: true });
    for (const name of await readdir(join(root, path))) await copyPublic(path + '/' + name);
  } else if (info.isFile()) {
    await mkdir(dirname(join(stage, path)), { recursive: true }); await copyFile(join(root, path), join(stage, path));
  } else throw new Error('invalid_source_file');
}
// Never traverse a developer's .git, node_modules, downloads, keys or queue.
for (const path of ['package.json', 'package-lock.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'packages', 'adapters/server', 'adapters/linux', 'ui', 'docs/SERVER_NODE.md', 'docs/LINUX_NODE.md']) await copyPublic(path);
await copyFile(join(root, 'adapters/linux/automesh-node'), join(stage, 'automesh-node'));
await copyFile(join(root, 'docs/LINUX_NODE.md'), join(stage, 'README.md'));
const npmCli = process.env.npm_execpath || (process.platform === 'win32' ? 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' : null);
const install = npmCli ? spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, windowsHide: true, encoding: 'utf8' }) :
  spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, encoding: 'utf8' });
if (install.status !== 0) throw new Error('linux_production_dependency_install_failed');
const files = [];
async function enumerate(path = '') {
  for (const entry of await readdir(join(stage, path), { withFileTypes: true })) {
    if (entry.name === '.bin' || path.startsWith('node_modules') && ['test', 'tests', 'example', 'examples', '.github'].includes(entry.name)) continue;
    // npm CLI links and dependency test/example trees are not runtime payload.
    const name = path ? path + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('package_symlink');
    if (entry.isDirectory()) await enumerate(name);
    else if (entry.isFile()) { const bytes = await readFile(join(stage, name)); files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    else throw new Error('invalid_package_file');
  }
}
await enumerate(); files.sort((a, b) => a.path.localeCompare(b.path));
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(stage, 'release-files.json'), JSON.stringify({ version, platform: 'linux-x64', runtimeVersion: runtime.version, files }, null, 2) + '\n');
await (await import('../adapters/linux/verify-release.mjs')).verifyRelease(stage);
// Write a minimal POSIX tar ourselves so executable modes survive builds on Windows.
function header(path, bytes) {
  const value = Buffer.alloc(512); let name = path, prefix = '';
  if (Buffer.byteLength(name) > 100) { const split = name.lastIndexOf('/'); prefix = name.slice(0, split); name = name.slice(split + 1); }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('tar_path_limit');
  value.write(name, 0, 100); value.write(prefix, 345, 155);
  const octal = (number, offset, length) => value.write(number.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  octal(['bin/node', 'automesh-node', 'adapters/linux/automesh-node'].includes(path) ? 0o755 : 0o644, 100, 8);
  octal(0, 108, 8); octal(0, 116, 8); octal(bytes, 124, 12); octal(0, 136, 12);
  value.fill(32, 148, 156); value[156] = 48; value.write('ustar\0', 257, 6); value.write('00', 263, 2);
  value.write(value.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return value;
}
const artifact = join(release, `linux-${version}-${Date.now()}.tar.gz`), gzip = createGzip({ level: 9 });
const completed = pipeline(gzip, createWriteStream(artifact, { flags: 'wx' }));
const emit = async bytes => { if (!gzip.write(bytes)) await once(gzip, 'drain'); };
for (const file of [...files, { path: 'release-files.json', bytes: (await lstat(join(stage, 'release-files.json'))).size }]) {
  await emit(header(file.path, file.bytes));
  for await (const part of createReadStream(join(stage, file.path))) await emit(part);
  if (file.bytes % 512) await emit(Buffer.alloc(512 - file.bytes % 512));
}
gzip.end(Buffer.alloc(1024)); await completed;
const bytes = await readFile(artifact), downloads = join(root, 'downloads'); await mkdir(downloads, { recursive: true });
const manifest = { version, platform: 'linux-x64', stage: 'personal-node-preview', url: '/downloads/Automesh-Node-Linux-x64.tar.gz', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), signed: false, runtimeVersion: runtime.version, runtimeArchiveSha256: runtime.linuxX64Sha256 };
await copyFile(artifact, join(downloads, 'Automesh-Node-Linux-x64.tar.gz'));
await writeFile(join(downloads, 'node-linux-release.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`Linux x64 preview built: ${artifact}\nSHA-256: ${manifest.sha256}\nNo service, firewall or existing data changed.\n`);
