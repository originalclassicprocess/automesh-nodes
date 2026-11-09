import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import { validateNodeConfig } from './runner.js';

// Diagnostics trust only this node's exported CA, not an arbitrary certificate
// and never rejectUnauthorized:false. No secrets, pairing codes or IDs in output.
export async function checkLan(config, configFile) {
  try { validateNodeConfig(config); }
  catch { return { error: 'address_or_config_changed' }; }
  let ca;
  try {
    const bytes = await readFile(config.caFile || join(dirname(configFile), 'node-ca.cer'));
    ca = `-----BEGIN CERTIFICATE-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  } catch { return { error: 'certificate_missing' }; }
  const origin = config.allowedOrigins[0];
  const result = { loopback: false, lanHttps: false, signaling: config.signalingEnabled === false ? 'disabled' : false };
  const info = host => new Promise(resolve => {
    const req = httpsRequest(`https://${host}:${config.port}/node/info`, { ca, headers: { Origin: origin }, timeout: 3000 }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; if (data.length > 4096) req.destroy(); });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 && response.headers['access-control-allow-origin'] === origin && JSON.parse(data).protocol === 'automesh-node-v1'); }
        catch { resolve(false); }
      });
      response.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false)); req.end();
  });
  const addresses = config.lanAddresses ?? [config.lanAddress];
  const checks = await Promise.all(['127.0.0.1', ...addresses].map(info));
  result.loopback = checks[0];
  result.addresses = addresses.map((address, i) => ({ address, https: checks[i + 1] }));
  result.lanHttps = addresses.length > 0 && checks.slice(1).every(Boolean);
  if (result.signaling !== 'disabled') result.signaling = await new Promise(resolve => {
    const socket = new WebSocket(`wss://${config.lanAddress || '127.0.0.1'}:${config.port}/signal`, { ca, origin, handshakeTimeout: 3000 });
    const finish = value => { clearTimeout(timer); socket.terminate(); resolve(value); };
    const timer = setTimeout(() => finish(false), 3500);
    socket.on('error', () => finish(false));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'probe' })));
    socket.on('message', data => {
      try { const message = JSON.parse(data); finish(message.type === 'probe_result' && message.protocol === 'mesh-signaling-v1'); }
      catch { finish(false); }
    });
  });
  return result;
}
