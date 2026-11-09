import { join } from 'node:path';
import { validateServerConfig, inside } from '../server/config.js';
import { readSafeFile } from '../server/files.js';

const fields = ['version', 'transport', 'dataDirectory', 'publicUrl', 'controlPort', 'allowedOrigins', 'masterKeyFile', 'courierRelay', 'signalingEnabled', 'maxBytes', 'maxMessages', 'maxFiles', 'maxFilesPerProfile'];
export function validatePassengerConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.transport !== 'tls-frontend-unix-v1' ||
      Object.keys(value).some(key => !fields.includes(key))) throw new Error('invalid_passenger_config');
  // Reuse the server policy for origins, quotas, paths and HTTPS public identity.
  const { transport, ...common } = value;
  validateServerConfig({ ...common, listenAddress: '127.0.0.1', port: 8080,
    tlsCertFile: join(value.dataDirectory || '/', '.unused-cert'), tlsKeyFile: value.masterKeyFile });
  if (value.dataDirectory.length > 80 || !/^\/[A-Za-z0-9_./-]+$/.test(value.dataDirectory)) throw new Error('invalid_passenger_config');
  return value;
}
export async function readPassengerConfig(file, applicationRoot) {
  const config = validatePassengerConfig(JSON.parse((await readSafeFile(file)).toString('utf8')));
  if (applicationRoot && [file, config.dataDirectory, config.masterKeyFile].some(path => inside(applicationRoot, path))) throw new Error('passenger_private_data_in_app');
  return config;
}
