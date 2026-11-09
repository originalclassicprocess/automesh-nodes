import { isIP } from 'node:net';
import { isAbsolute, resolve, relative, join } from 'node:path';
import { readSafeFile } from './files.js';
import { courierRelayUrl } from '../../packages/protocol/src/courier-protocol.js';
import { fileQueuePolicy } from '../../packages/protocol/src/attachment-protocol.js';

const fields = ['version', 'dataDirectory', 'publicUrl', 'listenAddress', 'port', 'controlPort', 'allowedOrigins', 'masterKeyFile', 'tlsCertFile', 'tlsKeyFile', 'tlsCaFile', 'courierRelay', 'signalingEnabled', 'maxBytes', 'maxMessages', 'maxFiles', 'maxFilesPerProfile'];
const absolute = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path;
export const inside = (directory, file) => { const rel = relative(directory, file); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
export function validateServerConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('invalid_server_config');
  fileQueuePolicy(value);
  let url;
  try { url = new URL(value.publicUrl); } catch { throw new Error('invalid_server_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      isIP(url.hostname) || url.hostname === 'localhost' || !url.hostname.includes('.') || value.publicUrl !== url.origin) throw new Error('invalid_server_url');
  if (value.version !== 1 || !absolute(value.dataDirectory) || value.dataDirectory === resolve('/') ||
      !absolute(value.masterKeyFile) || !absolute(value.tlsCertFile) || !absolute(value.tlsKeyFile) ||
      (value.tlsCaFile !== undefined && !absolute(value.tlsCaFile)) ||
      [value.masterKeyFile, value.tlsKeyFile].some(file => inside(value.dataDirectory, file)) ||
      !['127.0.0.1', '0.0.0.0'].includes(value.listenAddress) ||
      !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      !Number.isInteger(value.controlPort) || value.controlPort < 1024 || value.controlPort > 65535 || value.controlPort === value.port ||
      typeof value.signalingEnabled !== 'boolean' ||
      !Number.isInteger(value.maxBytes) || value.maxBytes < 1024 * 1024 || value.maxBytes > 512 * 1024 * 1024 ||
      !Number.isInteger(value.maxMessages) || value.maxMessages < 1 || value.maxMessages > 5000 ||
      !Array.isArray(value.allowedOrigins) || !value.allowedOrigins.length || value.allowedOrigins.length > 16) throw new Error('invalid_server_config');
  for (const origin of value.allowedOrigins) {
    let parsed; try { parsed = new URL(origin); } catch { throw new Error('invalid_server_origins'); }
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('invalid_server_origins');
  }
  if (value.courierRelay !== undefined && value.courierRelay !== '') courierRelayUrl(value.courierRelay);
  return value;
}
export async function readServerConfig(file) {
  return validateServerConfig(JSON.parse((await readSafeFile(file, { privateFile: false })).toString('utf8')));
}
export function credentialPaths(config, directory = process.env.CREDENTIALS_DIRECTORY) {
  if (directory !== undefined && !absolute(directory)) throw new Error('invalid_credentials_directory');
  if (directory && inside(config.dataDirectory, directory)) throw new Error('invalid_credentials_directory');
  return directory ? { masterKeyFile: join(directory, 'master-key'), tlsKeyFile: join(directory, 'tls-key'), tlsCertFile: join(directory, 'tls-cert'), tlsCaFile: config.tlsCaFile } : config;
}
