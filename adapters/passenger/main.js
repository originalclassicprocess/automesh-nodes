import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPassengerConfig } from './config.js';
import { initializeData, requestControl } from '../server/runner.js';
import { generateMasterKey } from '../server/secrets.js';

export async function main(args) {
  const [action, file, address, confirm] = args;
  if (!file) throw new Error('passenger_arguments_required');
  if (action === 'keygen' && args.length === 2) return generateMasterKey(resolve(file));
  const config = await readPassengerConfig(resolve(file));
  if (action === 'init' && args.length === 2) return initializeData(config, config.masterKeyFile);
  if (!['status', 'invite', 'admin-setup', 'remove', 'qr-pair', 'qr-signal'].includes(action) ||
      (action === 'remove' ? args.length !== 4 || confirm !== '--confirm-delete-node-data' : args.length !== 2)) throw new Error('passenger_arguments_required');
  const result = await requestControl(config, action, address, config.masterKeyFile);
  if (Buffer.isBuffer(result)) process.stdout.write(result);
  else console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  const allowed = ['server_already_initialized', 'server_data_in_use', 'server_control_failed', 'passenger_arguments_required'];
  console.error(allowed.includes(error.message) ? error.message : 'passenger_operation_failed'); process.exitCode = 1;
});
