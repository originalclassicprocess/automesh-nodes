import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { generateMasterKey } from './secrets.js';
import { initializeServer, runServer, controlRequest } from './runner.js';

export async function main(args = process.argv.slice(2)) {
  const [action, path, address, confirmation] = args;
  if (!path || !['keygen', 'init', 'start', 'status', 'invite', 'admin-setup', 'qr-pair', 'qr-signal', 'remove'].includes(action) ||
      (action === 'remove' ? args.length !== 4 || confirmation !== '--confirm-delete-node-data' : args.length !== 2)) throw new Error('invalid_server_command');
  if (action === 'keygen') { await generateMasterKey(resolve(path)); return; }
  if (action === 'init') { await initializeServer(resolve(path)); return; }
  if (action === 'start') {
    const service = await runServer(resolve(path));
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void service.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    console.log(JSON.stringify({ status: 'started', role: 'server', url: service.config.publicUrl }));
    return service;
  }
  const value = await controlRequest(resolve(path), action, address);
  if (Buffer.isBuffer(value)) process.stdout.write(value);
  else console.log(JSON.stringify(value, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // No raw exception, decrypted configuration, key material or admin token in logs.
    const codes = new Set(['linux_required', 'invalid_server_command', 'server_already_initialized', 'server_data_not_empty', 'server_data_in_use', 'server_lock_unavailable', 'unsafe_server_file', 'unsafe_server_parent', 'unsafe_server_data', 'invalid_server_config', 'invalid_server_url', 'invalid_server_origins', 'invalid_server_certificate']);
    console.error(codes.has(error.message) ? error.message : 'server_start_or_control_failed'); process.exitCode = 1;
  });
}
