import { cp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifySharedPackage } from './verify-shared-package.mjs';

const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.AUTOMESH_NPM_CLI;
if (!npm) throw new Error('Supply the trusted npm CLI path in AUTOMESH_NPM_CLI.');
const stage = join(root, '.release', 'shared-host', randomUUID()), app = join(stage, 'app');
await mkdir(app, { recursive: true });
const allowed = ['packages', 'ui', 'adapters/server', 'adapters/passenger', 'app.cjs', 'package.json', 'package-lock.json',
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/SHARED_HOSTING.md', 'docs/CLEAN_START.md', 'scripts/setup-shared-host.mjs', 'scripts/check-shared-host.mjs', 'scripts/verify-shared-package.mjs'];
for (const path of allowed) await cp(join(root, path), join(app, path), { recursive: true });
await run(process.execPath, [resolve(npm), 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, windowsHide: true, timeout: 120000 });
const { stdout: revision } = await run('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true });
const { stdout: changes } = await run('git', ['status', '--porcelain', '--', '.'], { cwd: root, windowsHide: true });
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(app, 'build.json'), JSON.stringify({ version, baseRevision: revision.trim(), sourceModified: !!changes.trim(), transport: 'tls-frontend-unix-v1', preview: true }) + '\n');
const files = [];
async function enumerate(directory = '') {
  for (const entry of await readdir(join(app, directory), { withFileTypes: true })) {
    // npm command links are not needed by the service; tar must not contain links.
    if (entry.name === '.bin' && directory === 'node_modules') continue;
    const path = directory ? directory + '/' + entry.name : entry.name;
    const info = await lstat(join(app, path));
    if (info.isSymbolicLink()) throw new Error('shared_package_symlink');
    if (info.isDirectory()) await enumerate(path);
    else if (info.isFile()) files.push({ path, bytes: info.size, sha256: createHash('sha256').update(await readFile(join(app, path))).digest('hex') });
    else throw new Error('shared_package_file');
  }
}
await enumerate();
await writeFile(join(app, 'release-files.json'), JSON.stringify({ version, transport: 'tls-frontend-unix-v1', files }, null, 2) + '\n');
const archive = join(stage, 'automesh-node.tar.gz');
await run('tar', ['-czf', archive, '--exclude=./node_modules/.bin', '-C', app, '.'], { windowsHide: true, timeout: 60000 });
// Verify the actual extraction, not just the staging inventory or tar listing.
const extracted = join(stage, 'verified-extraction'); await mkdir(extracted);
await run('tar', ['-xzf', archive, '-C', extracted], { windowsHide: true, timeout: 60000 });
await verifySharedPackage(extracted);
console.log(JSON.stringify({ archive, version, baseRevision: revision.trim(), sourceModified: !!changes.trim(), sha256: createHash('sha256').update(await readFile(archive)).digest('hex') }));
