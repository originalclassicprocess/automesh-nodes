import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { FILE_POLICY_BYTES } from '../packages/protocol/src/attachment-protocol.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build this Windows x64 preview on Windows x64');
const root = fileURLToPath(new URL('..', import.meta.url));
const release = join(root, '.release', 'home-node');
const payload = join(release, 'payload'); const wrapper = join(release, 'wrapper');
await mkdir(payload, { recursive: true }); await mkdir(wrapper, { recursive: true });
const runtime = JSON.parse(await readFile(join(root, 'adapters/windows/runtime.json'), 'utf8'));
const supplied = process.env.AUTOMESH_NODE_RUNTIME;
const runtimePath = supplied ? resolve(supplied) : join(release, `node-v${runtime.version}.exe`);
try { await stat(runtimePath); }
catch {
  if (supplied) throw new Error('Provided Node runtime not found');
  const response = await fetch(runtime.source); if (!response.ok) throw new Error('Official Node runtime download failed');
  const binary = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(binary).digest('hex') !== runtime.windowsX64Sha256) throw new Error('Node runtime checksum mismatch');
  await writeFile(runtimePath, binary);
}
const runtimeBytes = await readFile(runtimePath);
if (createHash('sha256').update(runtimeBytes).digest('hex') !== runtime.windowsX64Sha256) throw new Error('Node runtime checksum mismatch');
const runtimeVersion = spawnSync(runtimePath, ['--version'], { encoding: 'utf8', windowsHide: true });
if (runtimeVersion.status !== 0 || runtimeVersion.stdout.trim() !== `v${runtime.version}`) throw new Error('Wrong Node runtime');
await copyFile(runtimePath, join(payload, 'node.exe'));
// This plain-JS backend does not depend on Svelte's generated tsconfig.
// A clean CI checkout deliberately has no .svelte-kit directory yet.
const bundle = await rolldown({ input: join(root, 'adapters/windows/main.js'), platform: 'node', tsconfig: false,
  external: [/^node:/, 'bufferutil', 'utf-8-validate'] });
await bundle.write({ file: join(payload, 'node.cjs'), format: 'cjs', sourcemap: false }); await bundle.close();
for (const name of ['launch.vbs', 'launcher.ps1', 'node-ui.ps1', 'setup.ps1', 'secret-store.ps1', 'firewall.ps1', 'uninstall.vbs', 'uninstall.ps1']) {
  const data = await readFile(join(root, 'adapters/windows', name));
  await writeFile(join(payload, name), name.endsWith('.ps1') ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]) : data);
}
await copyFile(join(dirname(require.resolve('ws/package.json')), 'LICENSE'), join(payload, 'LICENSE-ws.txt'));
await copyFile(join(dirname(require.resolve('qrcode/package.json')), 'license'), join(payload, 'LICENSE-qrcode.txt'));
await copyFile(join(dirname(require.resolve('pngjs/package.json')), 'LICENSE'), join(payload, 'LICENSE-pngjs.txt'));
await copyFile(join(dirname(require.resolve('dijkstrajs/package.json')), 'LICENSE.md'), join(payload, 'LICENSE-dijkstrajs.txt'));
await copyFile(join(root, 'LICENSE'), join(payload, 'LICENSE-Automesh.txt'));
await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(payload, 'THIRD-PARTY-NOTICES.txt'));
try { await stat(join(payload, 'LICENSE-Node.txt')); }
catch {
  const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${runtime.version}/LICENSE`);
  if (!license.ok) throw new Error('Node license download failed');
  await writeFile(join(payload, 'LICENSE-Node.txt'), await license.text());
}
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const programNames = ['node.exe', 'node.cjs', 'launch.vbs', 'launcher.ps1', 'node-ui.ps1', 'setup.ps1', 'secret-store.ps1', 'firewall.ps1', 'uninstall.vbs', 'uninstall.ps1', 'LICENSE-Node.txt', 'LICENSE-ws.txt', 'LICENSE-qrcode.txt', 'LICENSE-pngjs.txt', 'LICENSE-dijkstrajs.txt', 'LICENSE-Automesh.txt', 'THIRD-PARTY-NOTICES.txt'];
const files = Object.fromEntries(await Promise.all(programNames.map(async name => {
  const bytes = await readFile(join(payload, name));
  return [name, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
})));
await writeFile(join(payload, 'node-build.json'), JSON.stringify({ version, stage: 'courier-preview', runtimeVersion: runtime.version,
  chatOfflineDelivery: true, courierDelivery: true, attachmentQueue: true, maxFileBytes: FILE_POLICY_BYTES, internetIncoming: false, memberManagement: true, secretProtection: 'windows-dpapi-current-user', files }, null, 2));
for (const name of ['install.vbs', 'install.ps1']) {
  const data = await readFile(join(root, 'adapters/windows', name));
  await writeFile(join(wrapper, name), name.endsWith('.ps1') ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]) : data);
}
const ps = (command) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference = 'Stop'; ${command}`], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Windows packaging failed: ${result.stderr}`);
};
const quote = value => `'${value.replaceAll("'", "''")}'`;
// Known program-only payload: never include .env, certificates, seeds, deploy
// keys, local chats, configs or the developer's node_modules tree.
const names = [...programNames, 'node-build.json'];
ps(`Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $taskStream = [IO.File]::Open(${quote(join(wrapper, 'payload.zip'))}, [IO.FileMode]::Create); $taskArchive = New-Object IO.Compression.ZipArchive($taskStream, [IO.Compression.ZipArchiveMode]::Create); try { ${names.map(name => `[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, ${quote(join(payload, name))}, ${quote(name)}, [IO.Compression.CompressionLevel]::Optimal) | Out-Null`).join('; ')} } finally { $taskArchive.Dispose(); $taskStream.Dispose() }`);
const target = join(release, 'Automesh-Node-Setup.exe');
const sed = ['[Version]', 'Class=IEXPRESS', 'SEDVersion=3', '[Options]', 'PackagePurpose=InstallApp', 'ShowInstallProgramWindow=0',
  'HideExtractAnimation=1', 'UseLongFileName=1', 'InsideCompressed=0', 'CAB_FixedSize=0', 'CAB_ResvCodeSigning=0', 'RebootMode=N',
  'InstallPrompt=', 'DisplayLicense=', 'FinishMessage=', `TargetName=${target}`, 'FriendlyName=Automesh Node',
  'AppLaunched=wscript.exe install.vbs', 'PostInstallCmd=<None>', 'AdminQuietInstCmd=', 'UserQuietInstCmd=', 'SourceFiles=SourceFiles',
  '[Strings]', 'FILE0="payload.zip"', 'FILE1="install.vbs"', 'FILE2="install.ps1"', '[SourceFiles]', `SourceFiles0=${wrapper}\\`,
  '[SourceFiles0]', '%FILE0%=', '%FILE1%=', '%FILE2%='].join('\r\n');
const sedPath = join(release, 'installer.sed'); await writeFile(sedPath, sed, 'utf8');
const iexpress = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'iexpress.exe');
const built = spawnSync(iexpress, ['/N', '/Q', sedPath], { cwd: wrapper, windowsHide: true, timeout: 120_000 });
if (built.status !== 0) throw new Error('IExpress installer build failed');
const installer = await readFile(target);
if (installer.length < 1024 * 1024 || installer[0] !== 0x4d || installer[1] !== 0x5a) throw new Error('Invalid installer output');
const publicDirectory = join(root, 'downloads'); await mkdir(publicDirectory, { recursive: true });
await copyFile(target, join(publicDirectory, 'Automesh-Node-Setup.exe'));
const manifest = { version, stage: 'courier-preview', url: '/downloads/Automesh-Node-Setup.exe', bytes: installer.length,
  sha256: createHash('sha256').update(installer).digest('hex'), signed: false, chatOfflineDelivery: true, courierDelivery: true, attachmentQueue: true, maxFileBytes: FILE_POLICY_BYTES, internetIncoming: false, secretProtection: 'windows-dpapi-current-user' };
await writeFile(join(publicDirectory, 'node-release.json'), JSON.stringify(manifest, null, 2));
process.stdout.write(`Windows preview ready: ${target}\nSHA-256: ${manifest.sha256}\nInstaller is unsigned; do not claim a production-trusted release.\n`);
