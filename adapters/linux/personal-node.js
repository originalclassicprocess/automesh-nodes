import { join, dirname } from 'node:path';
import { open } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { ensureDataDirectory, readSafeFile } from '../server/files.js';
import { generateMasterKey } from '../server/secrets.js';
import { validateServerConfig } from '../server/config.js';
import { initializeServer } from '../server/runner.js';
import { deploymentDefaults } from '../../packages/deployment/src/defaults.js';
export function personalNodeConfig(root, publicUrl, port, appOrigin = deploymentDefaults.appOrigin) {
  return validateServerConfig({ version: 1, dataDirectory: join(root, 'data'), publicUrl, listenAddress: '0.0.0.0',
    port, controlPort: port === 3004 ? 3005 : 3004, allowedOrigins: [appOrigin],
    masterKeyFile: join(root, 'private/master.key'), tlsCertFile: join(root, 'config/tls-cert.pem'), tlsKeyFile: join(root, 'private/tls-key.pem'),
    tlsCaFile: '/etc/ssl/certs/ca-certificates.crt', signalingEnabled: true, maxBytes: 64 * 1024 * 1024, maxMessages: 1000 });
}
async function syncDirectory(path) {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function writeNew(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
export async function createPersonalNode({ root, publicUrl, port, certPath, keyPath, appOrigin }) {
  const config = personalNodeConfig(root, publicUrl, port, appOrigin);
  const cert = await readSafeFile(certPath, { privateFile: false, limit: 128 * 1024 }), key = await readSafeFile(keyPath, { limit: 32768 });
  try {
    const x509 = new X509Certificate(cert);
    if (!x509.checkHost(new URL(publicUrl).hostname) || Date.parse(x509.validTo) <= Date.now() || Date.parse(x509.validFrom) > Date.now()) throw new Error('invalid_certificate');
    createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
    // Reserve a NEW private root; do not merge with any previous/partial setup.
    for (const directory of [root, join(root, 'private'), join(root, 'config')]) {
      await ensureDataDirectory(directory); await syncDirectory(dirname(directory));
    }
    await writeNew(config.tlsCertFile, cert); await writeNew(config.tlsKeyFile, key);
    await generateMasterKey(config.masterKeyFile); await syncDirectory(dirname(config.masterKeyFile));
    const configPath = join(root, 'config/server-config.json');
    await writeNew(configPath, JSON.stringify(config, null, 2) + '\n');
    await initializeServer(configPath);
    return { config, configPath };
  } finally { key.fill(0); }
}
