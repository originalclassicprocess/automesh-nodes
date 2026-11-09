import { runNode } from './runner.js';
import { readNodeConfig, windowsSecretProtector } from './secrets.js';
import { checkLan } from './lan-check.js';
import { deploymentDefaults, publicSignalingUrl } from '../../packages/deployment/src/defaults.js';

const diagnostic = process.argv[2] === '--check-lan';
const configFile = process.argv[diagnostic ? 3 : 2];
if (process.argv[2] === '--deployment-defaults') {
  process.stdout.write(JSON.stringify({ ...deploymentDefaults, signalingUrl: publicSignalingUrl(deploymentDefaults.appOrigin) }));
} else if (!configFile) { process.stderr.write('Automesh Node requires a configuration file. Use the Windows launcher.\n'); process.exitCode = 1; }
else if (diagnostic) {
  void readNodeConfig(configFile, windowsSecretProtector()).then(config => checkLan(config, configFile))
    .then(result => process.stdout.write(JSON.stringify(result)))
    .catch(() => { process.stdout.write(JSON.stringify({ error: 'protected_config_unavailable' })); process.exitCode = 1; });
} else void runNode(configFile).catch((error) => {
  // Do not dump configuration, account identifiers or crypto material.
  const safe = new Set(['invalid_node_config_or_lan_changed', 'invalid_node_primary_address', 'invalid_node_origins', 'invalid_node_configuration', 'unsafe_data_directory',
    'corrupt_node_state', 'corrupt_mailbox', 'mailbox_disk_limit', 'invalid_mailbox_limits', 'tls_required', 'unexpected_mailbox_file',
    'node_secret_protection_unavailable', 'node_secret_protection_failed', 'invalid_node_secret']);
  const reason = safe.has(error.message) ? error.message : ['EADDRINUSE', 'EACCES', 'ENOENT', 'EPERM'].includes(error.code) ? error.code : 'startup_failed';
  process.stderr.write(`Automesh Node could not start (${reason}). Check LAN address, certificate, disk and ports in the launcher.\n`);
  process.exitCode = 1;
});
