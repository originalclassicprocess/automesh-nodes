import { readFile } from 'node:fs/promises';
import { isIP, createServer as createTcpServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve, isAbsolute, dirname, join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { createHomeNode } from '../../packages/runtime/src/application.js';
import { courierRelayUrl } from '../../packages/protocol/src/courier-protocol.js';
import { fileQueuePolicy } from '../../packages/protocol/src/attachment-protocol.js';
import { readNodeConfig, protectNodeConfig, windowsSecretProtector } from './secrets.js';

export function privateIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function validateNodeConfig(config, interfaces = networkInterfaces()) {
  if (config) fileQueuePolicy(config);
  if (config?.courierRelay) courierRelayUrl(config.courierRelay);
  const localAddresses = Object.values(interfaces).flatMap(entries => entries ?? []).map(entry => entry.address);
  const addresses = config?.lanAddresses ?? [config?.lanAddress];
  const automatic = config?.networkMode === 'automatic';
  if (Array.isArray(addresses) && (addresses.length ? !addresses.includes(config?.lanAddress) : automatic && config?.lanAddress !== ''))
    throw new Error('invalid_node_primary_address');
  if (!config || config.version !== 1 || (config.networkMode !== undefined && !['automatic', 'manual'].includes(config.networkMode)) ||
      !Array.isArray(addresses) || addresses.length > 16 || new Set(addresses).size !== addresses.length ||
      addresses.some(address => !privateIPv4(address) || !localAddresses.includes(address)) ||
      (addresses.length ? !addresses.includes(config.lanAddress) : !automatic || config.lanAddress !== '') ||
      !isAbsolute(config.dataDirectory ?? '') || !isAbsolute(config.pfxFile ?? '') || typeof config.pfxPassword !== 'string' ||
      (config.caFile !== undefined && !isAbsolute(config.caFile)) ||
      !/^[a-f0-9]{64}$/.test(config.adminToken) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      !Number.isInteger(config.controlPort) || config.controlPort < 1024 || config.controlPort > 65535 || config.controlPort === config.port ||
      (config.signalingEnabled !== undefined && typeof config.signalingEnabled !== 'boolean') ||
      (config.maxMessages !== undefined && (!Number.isInteger(config.maxMessages) || config.maxMessages < 1 || config.maxMessages > 5000)) ||
      !Number.isInteger(config.maxBytes) || config.maxBytes < 1024 * 1024 || config.maxBytes > 512 * 1024 * 1024)
    throw new Error('invalid_node_config_or_lan_changed');
  return config;
}
export function nodeListenAddresses(config) {
  const lan = config.lanAddresses ?? [config.lanAddress];
  return ['127.0.0.1', ...(config.lanAddress ? [config.lanAddress] : []), ...lan.filter(address => address !== config.lanAddress)];
}
async function listen(server, port, host) {
  await new Promise((yes, no) => { server.once('error', no); server.listen(port, host, () => { server.removeListener('error', no); yes(); }); });
}
export function createControlReservation() {
  // GUI /status polls can arrive while DPAPI/TLS initialize. A bare net.Server
  // retained these sockets, so close() waited forever and control never started.
  // This is only a port lock, not a service: reject every connection immediately.
  return createTcpServer(socket => socket.destroy());
}
export async function runNode(configFile) {
  const secretProtector = windowsSecretProtector();
  const config = validateNodeConfig(await readNodeConfig(resolve(configFile), secretProtector));
  // Reserve the unique control port BEFORE reading/writing shared state.
  const reservation = createControlReservation(); await listen(reservation, config.controlPort, '127.0.0.1');
  let node;
  let stopping = false;
  const close = () => {
    if (stopping) return; stopping = true;
    void node?.close().finally(() => process.exit(0));
  };
  try {
    await protectNodeConfig(resolve(configFile), config, secretProtector);
    const pfx = await readFile(config.pfxFile);
    const addresses = nodeListenAddresses(config);
    node = await createHomeNode({ directory: config.dataDirectory,
      tls: { pfx, passphrase: config.pfxPassword, minVersion: 'TLSv1.2' },
      origins: config.allowedOrigins, adminToken: config.adminToken, maxBytes: config.maxBytes, maxMessages: config.maxMessages ?? 1000, maxFiles: config.maxFiles, maxFilesPerProfile: config.maxFilesPerProfile, onShutdown: close,
      hosts: [`localhost:${config.port}`, ...addresses.map(address => `${address}:${config.port}`)], courierRelay: config.courierRelay || '',
      secretProtector, signalingEnabled: config.signalingEnabled !== false,
      lanCa: config.signalingEnabled === false ? undefined : new X509Certificate(await readFile(config.caFile || join(dirname(resolve(configFile)), 'node-ca.cer'))).toString() });
    // One state, queue and signaling registry, reachable through every selected
    // interface. Never bind 0.0.0.0 or a public/VPN address implicitly.
    for (const address of addresses) await listen(node.createPublicServer(), config.port, address);
    await new Promise(resolveClose => reservation.close(resolveClose));
    await listen(node.control, config.controlPort, '127.0.0.1');
    process.once('SIGTERM', close); process.once('SIGINT', close);
    return node;
  } catch (error) {
    if (reservation.listening) await new Promise(resolveClose => reservation.close(resolveClose));
    await node?.close(); throw error;
  }
}
