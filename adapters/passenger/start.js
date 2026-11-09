import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPassenger } from './runner.js';

export async function startManagedNode(passenger) {
  const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const file = process.env.AUTOMESH_NODE_CONFIG;
  if (!file) throw new Error('passenger_config_required');
  const runtime = await runPassenger(file, { applicationRoot, inheritedSocketPath: process.env.LSNODE_SOCKET, bindFrontend: server => new Promise((yes, no) => {
    server.once('error', no);
    const done = () => { server.removeListener('error', no); yes(); };
    if (passenger) server.listen('passenger', done);
    else server.listen(8080, '127.0.0.1', done); // LiteSpeed rewrites this to its private Unix socket.
  }) });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    const timer = setTimeout(() => process.exit(1), 10_000); timer.unref();
    runtime.close().then(() => { clearTimeout(timer); process.exit(0); }, () => process.exit(1));
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  console.info('Automesh node started behind HTTPS frontend.');
  return runtime;
}
