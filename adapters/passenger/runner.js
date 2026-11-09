import { Server } from 'node:net';
import { join } from 'node:path';
import { lstat, unlink, chmod } from 'node:fs/promises';
import { createNodeService } from '../../packages/runtime/src/index.js';
import { loadAdmin } from '../server/runner.js';
import { loadServerProtector } from '../server/secrets.js';
import { acquireDataLock, checkDataDirectory } from '../server/files.js';
import { readPassengerConfig } from './config.js';
import { verifyUnixListener, verifyInheritedUnixDescriptor } from './transport.js';

// Hosting intercepts http.Server.listen. Bypass that hook ONLY for private
// listeners; never let the management server become the public application.
export const listenPrivate = (server, target, host) => new Promise((yes, no) => {
  server.once('error', no);
  Server.prototype.listen.call(server, target, ...(host ? [host] : []), () => { server.removeListener('error', no); yes(); });
});
const closeListener = server => new Promise((yes, no) => server.listening ? server.close(error => error ? no(error) : yes()) : yes());
export async function runPassenger(configFile, { applicationRoot, bindFrontend, inheritedSocketPath } = {}) {
  if (typeof bindFrontend !== 'function') throw new Error('managed_frontend_required');
  const config = await readPassengerConfig(configFile, applicationRoot);
  await checkDataDirectory(config.dataDirectory);
  const release = await acquireDataLock(config.dataDirectory);
  const reservation = new Server(socket => socket.destroy());
  const socketPath = join(config.dataDirectory, 'courier.sock');
  let protector, node, closePromise, ownSocket = false;
  const verifiedListeners = new WeakSet();
  const close = () => closePromise ??= (async () => {
    try { await closeListener(reservation); await node?.close(); }
    finally {
      protector?.destroy();
      try { if (ownSocket) await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      finally { await release(); }
    }
  })();
  try {
    await listenPrivate(reservation, config.controlPort, '127.0.0.1');
    protector = await loadServerProtector(config.masterKeyFile);
    const adminToken = await loadAdmin(config, protector);
    // Clean only an owned stale Unix socket, and only while holding the writer
    // lock. Never unlink a regular file, symlink or somebody else's object.
    try {
      const old = await lstat(socketPath);
      if (!old.isSocket() || old.uid !== process.getuid()) throw new Error('unsafe_courier_socket');
      await unlink(socketPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Verify fd 0 BEFORE handing the frontend to LiteSpeed. Its first proxied
    // request can arrive as soon as listen fires, before an async post-listen
    // check completes. Cache this trusted kernel proof, still require that the
    // actual serving handle is fd 0, and recheck after binding before publishing
    // management. No await/403 race on the cold-start request or WSS handshake.
    const inheritedVerified = await verifyInheritedUnixDescriptor(inheritedSocketPath);
    node = await createNodeService({ directory: config.dataDirectory, unixProxy: true,
      unixListenerProof: server => verifiedListeners.has(server) || (inheritedVerified && server.listening && server._handle?.fd === 0), adminToken,
      origins: [...new Set([...config.allowedOrigins, new URL(config.publicUrl).origin])], hosts: [new URL(config.publicUrl).host],
      panelConfig: { publicUrl: config.publicUrl, appUrl: config.allowedOrigins.find(url => url.startsWith('https://')) },
      maxBytes: config.maxBytes, maxMessages: config.maxMessages, maxFiles: config.maxFiles, maxFilesPerProfile: config.maxFilesPerProfile, secretProtector: protector,
      courierRelay: config.courierRelay || '', signalingEnabled: config.signalingEnabled,
      localRouteScope: 'internet', onShutdown: close });
    const internal = node.createPublicServer();
    await listenPrivate(internal, socketPath); ownSocket = true; await chmod(socketPath, 0o600);
    if (config.signalingEnabled) node.courier.attachLocalInternetUnix(socketPath, new URL(config.publicUrl).host);
    // Bind public first via the host's own hook, then verify that it really is
    // a Unix socket. A plain Node invocation must fail closed, not expose HTTP.
    const frontend = node.createPublicServer();
    await bindFrontend(frontend);
    if (!await verifyUnixListener(frontend, inheritedSocketPath)) throw new Error('managed_unix_socket_required');
    verifiedListeners.add(frontend);
    await closeListener(reservation);
    await listenPrivate(node.control, config.controlPort, '127.0.0.1');
    return { node, config, close };
  } catch (error) { await close(); throw error; }
}
