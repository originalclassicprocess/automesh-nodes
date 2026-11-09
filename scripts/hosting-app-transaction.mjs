// Operator-only CLI. Never imported by the public application or served over HTTP.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

const managed = ['build', 'server', 'src', 'nodes', 'docs', 'app.cjs', 'package.json', 'package-lock.json',
  'release-manifest.json', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md', 'README.ru.md', 'SECURITY.md', 'CONTRIBUTING.md', '.env.example'];
const idPattern = /^(deploy|rollback)-[0-9]+-[a-f0-9-]{36}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function inside(parent, path) {
  const child = relative(resolve(parent), resolve(path));
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Path outside deployment directory');
  return resolve(path);
}
function regular(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Unexpected file type in deployment');
}
function present(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function files(directory, prefix = '') {
  regular(directory, true);
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name); const name = prefix + entry.name;
    if (entry.isDirectory()) return files(path, name + '/');
    regular(path); return [name];
  }).sort();
}
function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
function privateDirectory(root, name) {
  const path = inside(root, join(root, name));
  if (!present(path)) mkdirSync(path, { mode: 0o700 });
  regular(path, true);
  return path;
}
function checkManaged(root) {
  for (const name of managed) {
    const path = join(root, name);
    if (!present(path)) continue;
    if (lstatSync(path).isDirectory()) files(path); else regular(path);
  }
}
function rewriteManifest(root, version, retainedAssetVersions = []) {
  atomicJson(join(root, 'release-manifest.json'), { version, retainedAssetVersions,
    files: files(root).filter(path => path !== 'release-manifest.json').map(path => ({ path, sha256: sha(readFileSync(join(root, path))) })) });
  return validateRelease(root);
}
function snapshot(root) {
  return managed.flatMap(name => {
    const path = join(root, name);
    if (!present(path)) return [];
    const names = lstatSync(path).isDirectory() ? files(path, name + '/') : [name];
    return names.map(path => ({ path, sha256: sha(readFileSync(join(root, path))) }));
  });
}
export function releaseVersion(root) {
  const value = json(join(root, 'build/client/_app/version.json')).version;
  if (typeof value !== 'string' || !versionPattern.test(value)) throw new Error('Invalid release version');
  return value;
}
export function validateRelease(root) {
  regular(root, true); regular(join(root, 'release-manifest.json'));
  const manifest = json(join(root, 'release-manifest.json'));
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 10000)
    throw new Error('Invalid release manifest');
  const listed = new Set();
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_.\/-]+$/.test(file.path) ||
        file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        !managed.includes(file.path.split('/')[0]) || file.path === 'release-manifest.json' ||
        listed.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid release manifest entry');
    const path = inside(root, join(root, file.path));
    // Check ancestors as well, not only the leaf (no symlink escapes).
    for (let parent = dirname(path); parent !== resolve(root); parent = dirname(parent)) regular(parent, true);
    regular(path);
    if (sha(readFileSync(path)) !== file.sha256) throw new Error('Release checksum mismatch');
    listed.add(file.path);
  }
  const actual = files(root).filter(path => path !== 'release-manifest.json');
  if (actual.length !== listed.size || actual.some(path => !listed.has(path))) throw new Error('Release contains unlisted files');
  if (manifest.version !== releaseVersion(root)) throw new Error('Release version mismatch');
  for (const required of ['build/handler.js', 'server/app.js', 'app.cjs', 'package.json', 'package-lock.json'])
    if (!listed.has(required)) throw new Error('Incomplete release');
  // Legacy releases remain rollback-compatible; new MIT releases carry notice.
  if (json(join(root, 'package.json')).license === 'MIT' && !listed.has('LICENSE')) throw new Error('MIT release license missing');
  return manifest;
}

function dependencyState(root) {
  const pkg = json(join(root, 'package.json')); const lock = json(join(root, 'package-lock.json'));
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('Unsupported dependency lock');
  const sort = value => Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([sort(pkg.dependencies), sort(pkg.optionalDependencies), sort(pkg.overrides),
    Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev).sort(([a], [b]) => a.localeCompare(b))]);
}
function equivalentCompressedAsset(source, target) {
  const extension = source.endsWith('.gz') ? '.gz' : source.endsWith('.br') ? '.br' : null;
  if (!extension) return false;
  const oldPlain = source.slice(0, -extension.length); const newPlain = target.slice(0, -extension.length);
  // Same decoded bytes are insufficient unless BOTH copies also match their
  // canonical uncompressed asset. Never hide an actual JS/CSS name collision.
  if (!present(oldPlain) || !present(newPlain)) return false;
  regular(oldPlain); regular(newPlain);
  const plain = readFileSync(oldPlain); const next = readFileSync(newPlain);
  if (plain.length > 16 * 1024 * 1024 || !plain.equals(next)) return false;
  const decode = extension === '.gz' ? gunzipSync : brotliDecompressSync;
  try {
    const options = { maxOutputLength: plain.length + 1 };
    return decode(readFileSync(source), options).equals(plain) && decode(readFileSync(target), options).equals(plain);
  } catch { return false; }
}
function retainAssets(root, candidate, manifest) {
  const old = join(root, 'build/client/_app/immutable');
  if (!existsSync(old)) return;
  for (const name of files(old)) {
    const source = join(old, name); const target = join(candidate, 'build/client/_app/immutable', name);
    if (existsSync(target)) {
      if (sha(readFileSync(source)) !== sha(readFileSync(target)) && !equivalentCompressedAsset(source, target))
        throw new Error('Immutable asset collision');
    } else { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target); }
  }
  const retained = new Set([...(manifest.retainedAssetVersions || []), releaseVersion(root)]);
  atomicJson(join(candidate, 'release-manifest.json'), { ...manifest, retainedAssetVersions: [...retained],
    files: files(candidate).filter(path => path !== 'release-manifest.json').map(path => ({ path, sha256: sha(readFileSync(join(candidate, path))) })) });
  validateRelease(candidate);
}
function lastDeployment(root) {
  const path = join(root, '.deploy-last.json');
  if (!existsSync(path)) return null;
  regular(path); const data = json(path);
  if (data.schema !== 1 || !idPattern.test(data.id) || !versionPattern.test(data.version) || !Array.isArray(data.managedFiles)) throw new Error('Invalid deployment state');
  return data;
}
function saveLast(root, data) {
  const path = join(root, '.deploy-last.json');
  if (data) atomicJson(path, data);
  else if (existsSync(path)) unlinkSync(path); // Only our own metadata, never user storage.
}
function restore(root, backup, changes, retained) {
  mkdirSync(retained, { recursive: true, mode: 0o700 });
  for (const change of [...changes].reverse()) {
    if (!managed.includes(change.path)) throw new Error('Invalid recovery path');
    const live = join(root, change.path);
    if (existsSync(live)) renameSync(live, join(retained, change.path));
    if (change.saved) renameSync(join(backup, change.path), live);
  }
}

// Hooks make transactional filesystem behavior testable without touching cPanel.
export async function updateApplication({ root, candidate, operation = 'deploy', lifecycle, probe }) {
  root = resolve(root); regular(root, true);
  if (!['deploy', 'rollback'].includes(operation)) throw new Error('Unsupported deployment operation');
  for (const name of ['.deploy-incoming', '.deploy-backups', '.deploy-failed']) privateDirectory(root, name);
  checkManaged(root);
  const lock = join(root, '.deploy-lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error('Another deployment is running; inspect .deploy-lock before retrying'); }
  let interrupted = false;
  let releaseLock = true;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt); process.on('SIGHUP', interrupt);
  const checkpoint = () => { if (interrupted) throw new Error('Deployment interrupted'); };
  try {
    const previousState = lastDeployment(root);
    if (operation === 'rollback') {
      if (!previousState) throw new Error('No automated deployment to roll back');
      if (releaseVersion(root) !== previousState.version) throw new Error('Live version changed outside automation; refuse rollback');
      if (JSON.stringify(snapshot(root)) !== JSON.stringify(previousState.managedFiles)) throw new Error('Live files changed outside automation; refuse rollback');
      const backup = join(root, '.deploy-backups', previousState.id); regular(backup, true);
      regular(join(backup, 'journal.json')); const journal = json(join(backup, 'journal.json'));
      if (journal.schema !== 1 || journal.state !== 'committed' || journal.version !== previousState.version ||
          typeof journal.previousVersion !== 'string' || !versionPattern.test(journal.previousVersion) || !Array.isArray(journal.changes) ||
          journal.changes.length !== managed.length || new Set(journal.changes.map(change => change.path)).size !== managed.length ||
          journal.changes.some(change => !managed.includes(change.path) || typeof change.saved !== 'boolean')) throw new Error('Invalid rollback journal');
      if (JSON.stringify(snapshot(backup)) !== JSON.stringify(journal.snapshotFiles)) throw new Error('Rollback snapshot checksum mismatch');
      // Rebuild a candidate from the snapshot, never consume the only backup.
      // Rollback then uses the same tested transaction and recovery as deployment.
      candidate = join(root, '.deploy-incoming', `rollback-${Date.now()}-${randomUUID()}`);
      mkdirSync(candidate, { mode: 0o700 });
      for (const change of journal.changes) if (change.saved) {
        const path = join(backup, change.path);
        if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('Rollback backup missing');
        if (lstatSync(path).isDirectory()) files(path); else regular(path);
        cpSync(path, join(candidate, change.path), { recursive: true });
      }
      if (releaseVersion(candidate) !== journal.previousVersion) throw new Error('Rollback snapshot version mismatch');
      rewriteManifest(candidate, journal.previousVersion);
    }
    candidate = inside(join(root, '.deploy-incoming'), candidate);
    for (let parent = resolve(candidate); parent !== root; parent = dirname(parent)) regular(parent, true);
    const manifest = validateRelease(candidate);
    // Deliberately REFUSE before touching the live site when dependencies change.
    // A managed cPanel node_modules symlink must not be replaced/cleared by npm ci.
    if (dependencyState(root) !== dependencyState(candidate)) throw new Error('Production dependencies changed; manual dependency maintenance required before deployment');
    retainAssets(root, candidate, manifest);
    const id = `deploy-${Date.now()}-${randomUUID()}`;
    const backup = join(root, '.deploy-backups', id); mkdirSync(backup, { recursive: true, mode: 0o700 });
    const journal = { schema: 1, state: 'prepared', version: manifest.version,
      previousVersion: releaseVersion(root), previousState, snapshotFiles: snapshot(root), changes: [] };
    atomicJson(join(backup, 'journal.json'), journal);
    let stopAttempted = false; let stopped = false;
    try {
      checkpoint(); stopAttempted = true; await lifecycle('stop'); stopped = true;
      for (const path of managed) {
        checkpoint();
        const live = join(root, path); const saved = present(live);
        if (saved) renameSync(live, join(backup, path));
        journal.changes.push({ path, saved });
        atomicJson(join(backup, 'journal.json'), journal);
        if (existsSync(join(candidate, path))) cpSync(join(candidate, path), live, { recursive: true });
      }
      checkpoint(); await lifecycle('start'); await probe(manifest.version); checkpoint();
      // Journal first; pointer second. Neither is read by the public application.
      journal.state = 'committed'; atomicJson(join(backup, 'journal.json'), journal);
      saveLast(root, { schema: 1, id, version: manifest.version, managedFiles: snapshot(root) });
      return { version: manifest.version, operation, backup };
    } catch (error) {
      if (stopped) {
        try {
          // stop/start adapters must be idempotent; never replace live files
          // unless stopping is confirmed. Ambiguous stop errors preserve snapshots.
          await lifecycle('stop');
          const retained = join(root, '.deploy-failed', id);
          restore(root, backup, journal.changes, retained);
          saveLast(root, previousState);
          await lifecycle('start'); await probe(journal.previousVersion);
          journal.state = 'recovered'; atomicJson(join(backup, 'journal.json'), journal);
        } catch {
          releaseLock = false;
          throw new Error('Deployment and recovery failed. Backups preserved; operator recovery required');
        }
      }
      else if (stopAttempted) {
        // A provider may have stopped the process before reporting an error.
        // No files were replaced yet; try to bring that original version back.
        try { await lifecycle('start'); await probe(journal.previousVersion); }
        catch { releaseLock = false; throw new Error('Stopping failed and original app could not be verified; no live files replaced'); }
      }
      throw error;
    }
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); process.off('SIGHUP', interrupt);
    if (releaseLock) rmdirSync(lock); // Empty lock created here; ambiguous recovery keeps it for inspection.
  }
}

export async function stopLiteSpeedWorkers(root, run = spawnSync, signal = process.kill, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), uid = process.getuid?.()) {
  if (!Number.isInteger(uid)) throw new Error('Cannot establish worker owner');
  const title = 'lsnode:' + resolve(root) + '/';
  const workers = () => {
    const result = run('ps', ['-u', String(uid), '-o', 'pid=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0 || typeof result.stdout !== 'string') throw new Error('Cannot establish worker state');
    return result.stdout.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new Error('Cannot establish worker state');
      return { pid: Number(match[1]), title: match[2] };
    }).filter(worker => worker.pid > 1 && worker.pid !== process.pid && worker.title === title);
  };
  for (const worker of workers()) {
    if (!workers().some(current => current.pid === worker.pid)) continue;
    try { signal(worker.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') continue; throw new Error('Cannot close previous app worker'); }
    let remaining = 80;
    while (workers().some(current => current.pid === worker.pid)) {
      if (!remaining--) throw new Error('Previous app worker did not close; no live files replaced');
      await wait(250);
    }
  }
}
export function selectorLifecycle(root, run = spawnSync, accountHome = homedir(), closeWorkers = async () => {
  if (process.platform === 'linux') await stopLiteSpeedWorkers(root, run);
}) {
  const appRoot = relative(accountHome, root).split(sep).join('/');
  if (!appRoot || appRoot.startsWith('..') || isAbsolute(appRoot)) throw new Error('Application must be below SSH account home');
  const command = action => {
    const args = [action, '--json', '--interpreter', 'nodejs'];
    if (action !== 'get') args.push('--app-root', appRoot);
    const result = run('/sbin/cloudlinux-selector', args,
      { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    let response;
    try { response = JSON.parse(result.stdout); } catch { /* never print provider output/env */ }
    if (result.status !== 0 || response?.result !== 'success') throw new Error(`CloudLinux ${action} failed`);
    return response;
  };
  const status = () => {
    const matches = [];
    function scan(value) {
      if (!value || typeof value !== 'object') return;
      if (value.applications?.[appRoot]) matches.push(value.applications[appRoot]);
      for (const [key, child] of Object.entries(value)) if (key !== 'env_vars') scan(child);
    }
    scan(command('get'));
    if (matches.length !== 1 || !['started', 'stopped'].includes(matches[0].app_status)) throw new Error('Cannot establish cPanel application status');
    return matches[0].app_status;
  };
  return async action => {
    if (!['start', 'stop'].includes(action)) throw new Error('Invalid lifecycle operation');
    const target = action === 'start' ? 'started' : 'stopped';
    if (status() !== target) command(action);
    if (status() !== target) throw new Error(`CloudLinux ${action} not confirmed`);
    // Selector status alone is not proof that LiteSpeed retired cached code.
    if (action === 'stop') await closeWorkers();
  };
}
export function liveProbe(root, origin) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Deployment origin must be canonical HTTPS');
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled');
  const WebSocket = createRequire(join(root, 'package.json'))('ws');
  return async version => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const versionResponse = await fetch(`${origin}/_app/version.json?deployment=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
        if (!versionResponse.ok || (await versionResponse.json()).version !== version) throw new Error('Version not active');
        const shell = await fetch(origin + '/', { signal: AbortSignal.timeout(5000), cache: 'no-store' });
        if (!shell.ok || shell.headers.get('x-automesh-version') !== version) throw new Error('Shell not active');
        await shell.body?.cancel();
        const health = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(5000) });
        const status = await health.json();
        if (!health.ok || status.status !== 'ok' || status.protocol !== 'mesh-signaling-v1') throw new Error('Health check failed');
        await new Promise((resolve, reject) => {
          const ws = new WebSocket(origin.replace(/^https:/, 'wss:') + '/signal', { origin });
          const finish = error => { clearTimeout(timer); ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); error ? reject(error) : resolve(); };
          const timer = setTimeout(() => finish(new Error('Signaling probe timeout')), 5000);
          ws.on('error', () => finish(new Error('Signaling unavailable')));
          ws.on('open', () => ws.send(JSON.stringify({ type: 'probe' })));
          ws.on('message', data => {
            try { const message = JSON.parse(data.toString()); finish(message.type === 'probe_result' && message.protocol === 'mesh-signaling-v1' ? null : new Error('Signaling protocol mismatch')); }
            catch { finish(new Error('Invalid signaling response')); }
          });
        });
        return;
      } catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    throw new Error('New application did not pass HTTPS/version/WSS checks');
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, rootArg, origin, candidate] = process.argv.slice(2);
    if (!['deploy', 'rollback'].includes(operation) || !rootArg || !origin || (operation === 'deploy' && !candidate))
      throw new Error('Usage: deployment.mjs deploy|rollback <app-root> <https-origin> [candidate]');
    const root = inside(homedir(), rootArg);
    if (root !== resolve(rootArg) || basename(root).startsWith('.')) throw new Error('Invalid application root');
    const result = await updateApplication({ root, candidate, operation,
      lifecycle: selectorLifecycle(root), probe: liveProbe(root, origin) });
    console.log(`${result.operation} verified: ${result.version}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
