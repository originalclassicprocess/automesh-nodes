// One-time operator bootstrap. Run over authenticated SSH, not as an HTTP API.
// Creates only named node directories; never touches the main app or overwrites
// keys, queues, configs or existing hosting rules.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile, open } from 'node:fs/promises';
import { ensureDataDirectory, checkDataDirectory, safeParents } from '../adapters/server/files.js';
import { generateMasterKey } from '../adapters/server/secrets.js';
import { initializeData } from '../adapters/server/runner.js';
import { validatePassengerConfig } from '../adapters/passenger/config.js';
import { deploymentDefaults } from '../packages/deployment/src/defaults.js';

export async function setup(home, publicUrl, documentRoot, controlPort, appOrigin = deploymentDefaults.appOrigin) {
  const applicationRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  if (!/^\/home\/[a-z0-9_-]+$/.test(home) || applicationRoot !== join(home, 'automesh-node-app') ||
      documentRoot !== join(home, new URL(publicUrl).hostname)) throw new Error('unexpected_setup_target');
  const privateDirectory = join(home, '.automesh-node-private'), file = join(privateDirectory, 'config.json');
  const config = validatePassengerConfig({ version: 1, transport: 'tls-frontend-unix-v1', publicUrl,
    dataDirectory: join(home, '.automesh-node-data'), masterKeyFile: join(privateDirectory, 'master.key'),
    controlPort: Number(controlPort), allowedOrigins: [appOrigin], signalingEnabled: true, maxBytes: 64 * 1024 * 1024, maxMessages: 1000 });
  await safeParents(documentRoot);
  const root = await lstat(documentRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o022)) throw new Error('unsafe_document_root');
  await ensureDataDirectory(privateDirectory); // Fail if already present: never regenerate secrets.
  await checkDataDirectory(privateDirectory);
  await generateMasterKey(config.masterKeyFile);
  const configHandle = await open(file, 'wx', 0o600);
  try { await configHandle.writeFile(JSON.stringify(config, null, 2)); await configHandle.sync(); } finally { await configHandle.close(); }
  await initializeData(config, config.masterKeyFile);
  const htaccess = join(documentRoot, '.htaccess');
  let existing = '';
  try {
    const info = await lstat(htaccess);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 32768) throw new Error('unsafe_htaccess');
    existing = await readFile(htaccess, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const rules = `# BEGIN AUTOMESH NODE HTTPS v1\nRewriteEngine On\nRewriteCond %{REQUEST_URI} !^/\\.well-known/(acme-challenge|pki-validation)/\nRewriteCond %{HTTPS} !=on\nRewriteRule ^ ${publicUrl}%{REQUEST_URI} [R=308,L]\n# END AUTOMESH NODE HTTPS v1\n\n`;
  // Preserve hosting content byte-for-byte below our new canonical redirect.
  // This is a one-time setup; future updates must not re-run it.
  const handle = await open(htaccess, existing ? 'r+' : 'wx', 0o644);
  try { await handle.writeFile(rules + existing); await handle.truncate(Buffer.byteLength(rules + existing)); await handle.sync(); }
  finally { await handle.close(); }
  console.log('Private node state initialized; HTTPS rules added only to the node subdomain.');
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (![4, 5].includes(args.length)) { console.error('Expected home, HTTPS URL, separate document root, control port and optional app HTTPS origin.'); process.exitCode = 1; }
  else setup(...args).catch(() => { console.error('Node setup failed; existing data and any created credentials are preserved. Inspect private paths before retrying.'); process.exitCode = 1; });
}
