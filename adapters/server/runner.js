import { randomBytes, X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { createServer } from 'node:net';
import { createNodeService, sealSecret, openSecret } from '../../packages/runtime/src/index.js';
import { writeAtomic } from '../../packages/runtime/src/files.js';
import { readServerConfig, credentialPaths } from './config.js';
import { loadServerProtector } from './secrets.js';
import { acquireDataLock, checkDataDirectory, ensureDataDirectory, readSafeFile } from './files.js';

const ADMIN_PURPOSE = 'automesh-node-server-admin-v1';
const adminFile = config => join(config.dataDirectory, 'server-admin.json');
export async function loadAdmin(config, protector) {
  const bytes = await readSafeFile(adminFile(config));
  const saved = await openSecret(JSON.parse(bytes.toString('utf8')), ADMIN_PURPOSE, protector);
  if (Object.keys(saved).join(',') !== 'adminToken' || !/^[a-f0-9]{64}$/.test(saved.adminToken)) throw new Error('invalid_server_admin');
  return saved.adminToken;
}
export async function initializeServer(configFile) {
  const config = await readServerConfig(configFile);
  return initializeData(config);
}
export async function initializeData(config, masterKeyFile = credentialPaths(config).masterKeyFile) {
  try { await ensureDataDirectory(config.dataDirectory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const release = await acquireDataLock(config.dataDirectory);
  let protector;
  try {
    protector = await loadServerProtector(masterKeyFile);
    try { await readSafeFile(adminFile(config)); throw new Error('server_already_initialized'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Never initialize over orphaned state after losing the admin/key backup.
    const { readdir } = await import('node:fs/promises');
    if ((await readdir(config.dataDirectory)).some(name => name !== '.writer.lock')) throw new Error('server_data_not_empty');
    const sealed = await sealSecret({ adminToken: randomBytes(32).toString('hex') }, ADMIN_PURPOSE, protector);
    await openSecret(sealed, ADMIN_PURPOSE, protector);
    await writeAtomic(config.dataDirectory, 'server-admin.json', sealed);
  } finally { protector?.destroy(); await release(); }
}
const listen = (server, port, host) => new Promise((yes, no) => {
  server.once('error', no); server.listen(port, host, () => { server.removeListener('error', no); yes(); });
});
const closeListener = server => new Promise((yes, no) => server.listening ? server.close(error => error ? no(error) : yes()) : yes());
export async function runServer(configFile) {
  const config = await readServerConfig(configFile);
  await checkDataDirectory(config.dataDirectory);
  const release = await acquireDataLock(config.dataDirectory);
  const reservation = createServer(socket => socket.destroy());
  let protector, node, closePromise;
  const close = () => closePromise ??= (async () => {
    try { await closeListener(reservation); await node?.close(); }
    finally { protector?.destroy(); await release(); }
  })();
  try {
    await listen(reservation, config.controlPort, '127.0.0.1');
    const paths = credentialPaths(config);
    protector = await loadServerProtector(paths.masterKeyFile);
    const adminToken = await loadAdmin(config, protector);
    const cert = await readSafeFile(paths.tlsCertFile, { privateFile: false, limit: 128 * 1024 });
    const key = await readSafeFile(paths.tlsKeyFile, { limit: 32768 });
    const x509 = new X509Certificate(cert), hostname = new URL(config.publicUrl).hostname;
    if (!x509.checkHost(hostname) || Date.parse(x509.validTo) <= Date.now() || Date.parse(x509.validFrom) > Date.now()) throw new Error('invalid_server_certificate');
    const tls = { cert, key, minVersion: 'TLSv1.2' };
    createSecureContext(tls); // Check private-key/certificate correspondence before changing state.
    const ca = paths.tlsCaFile ? await readSafeFile(paths.tlsCaFile, { privateFile: false, limit: 128 * 1024 }) : cert;
    node = await createNodeService({ directory: config.dataDirectory, tls, adminToken,
      origins: [...new Set([...config.allowedOrigins, new URL(config.publicUrl).origin])], hosts: [new URL(config.publicUrl).host, `127.0.0.1:${config.port}`],
      panelConfig: { publicUrl: config.publicUrl, appUrl: config.allowedOrigins.find(url => url.startsWith('https://')) },
      maxBytes: config.maxBytes, maxMessages: config.maxMessages, maxFiles: config.maxFiles, maxFilesPerProfile: config.maxFilesPerProfile, secretProtector: protector,
      courierRelay: config.courierRelay || '', signalingEnabled: config.signalingEnabled,
      localRouteScope: 'internet', localSignalServername: hostname, lanCa: ca, onShutdown: close });
    // Courier uses verified loopback HTTPS, never the Internet DNS route back
    // into this host. A wildcard bind also accepts loopback without a second socket.
    const server = node.createPublicServer();
    await listen(server, config.port, config.listenAddress);
    if (config.listenAddress === '0.0.0.0' && config.signalingEnabled) node.courier.attachLocalInternet(`wss://127.0.0.1:${config.port}/signal`, ca, hostname);
    await closeListener(reservation); await listen(node.control, config.controlPort, '127.0.0.1');
    return { node, config, close };
  } catch (error) { await close(); throw error; }
}
export async function controlRequest(configFile, action, address) {
  return requestControl(await readServerConfig(configFile), action, address);
}
export async function requestControl(config, action, address, masterKeyFile = credentialPaths(config).masterKeyFile) {
  const protector = await loadServerProtector(masterKeyFile);
  try {
    const token = await loadAdmin(config, protector);
    const route = { status: '/status', invite: '/pair-code', 'admin-setup': '/admin-setup', remove: '/members/remove', 'qr-pair': '/qr/pair', 'qr-signal': '/qr/signal' }[action];
    if (!route) throw new Error('invalid_control_action');
    const response = await fetch(`http://127.0.0.1:${config.controlPort}${route}`, {
      method: ['invite', 'remove', 'admin-setup'].includes(action) ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(action === 'remove' ? { 'Content-Type': 'application/json' } : {}) },
      ...(action === 'remove' ? { body: JSON.stringify({ address, confirm: 'remove-node-data' }) } : {}),
      redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('server_control_failed');
    if (action.startsWith('qr-')) return Buffer.from(await response.arrayBuffer());
    const value = await response.json();
    if (action === 'status') { delete value.pairCode; delete value.pairExpires; }
    return value;
  } finally { protector.destroy(); }
}
