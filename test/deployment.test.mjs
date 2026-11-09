import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentDefaults, httpsOrigin, publicSignalingUrl } from '../packages/deployment/src/defaults.js';
import { personalNodeConfig } from '../adapters/linux/personal-node.js';
import { validatePassengerConfig } from '../adapters/passenger/config.js';
import { text } from '../adapters/linux/language.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { createNodeService } from '../packages/runtime/src/index.js';
import { protector } from './fixtures.mjs';

test('clean deployment defaults and configurable HTTPS origins', () => {
  assert.equal(deploymentDefaults.projectOrigin, '');
  assert.equal(publicSignalingUrl(deploymentDefaults.appOrigin), 'wss://automesh.online/signal');
  assert.equal(httpsOrigin('https://custom.example:8443'), 'https://custom.example:8443');
  for (const value of ['http://app.example', 'https://user:pass@app.example', 'https://app.example/', 'https://app.example/path', 'https://app.example?token=x'])
    assert.throws(() => httpsOrigin(value));
  assert.ok(text('en', 'app').includes(deploymentDefaults.appOrigin));
  assert.ok(text('ru', 'app').includes(deploymentDefaults.appOrigin));
});
test('fresh personal and shared nodes allow the messenger, not the information site', { skip: process.platform !== 'linux' }, () => {
  const personal = personalNodeConfig('/tmp/automesh-node-fixture', 'https://node.example', 3003);
  assert.deepEqual(personal.allowedOrigins, [deploymentDefaults.appOrigin]);
  assert.deepEqual(personalNodeConfig('/tmp/automesh-node-fixture', 'https://node.example', 3003, 'https://custom.example').allowedOrigins, ['https://custom.example']);
  const { port, listenAddress, tlsCertFile, tlsKeyFile, tlsCaFile, ...common } = personal;
  const shared = validatePassengerConfig({ ...common, publicUrl: deploymentDefaults.nodeOrigin, transport: 'tls-frontend-unix-v1' });
  assert.deepEqual(shared.allowedOrigins, [deploymentDefaults.appOrigin]);
  assert.ok(!shared.allowedOrigins.includes(deploymentDefaults.projectOrigin));
});

test('node on .space accepts .online and refuses the information site or foreign browser origins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automesh-domain-fixture-'));
  let node, server;
  try {
    node = await createNodeService({ directory, testHttp: true, hosts: [new URL(deploymentDefaults.nodeOrigin).host],
      origins: [deploymentDefaults.appOrigin, deploymentDefaults.nodeOrigin], adminToken: 'a'.repeat(64),
      secretProtector: protector(), signalingEnabled: false, localRouteScope: 'internet' });
    server = node.createPublicServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    for (const origin of [deploymentDefaults.appOrigin, deploymentDefaults.nodeOrigin, 'https://information.example', 'https://untrusted.example']) {
      const response = await new Promise((yes, no) => {
        const req = request(`http://127.0.0.1:${server.address().port}/node/info`, {
          headers: { Host: new URL(deploymentDefaults.nodeOrigin).host, Origin: origin } }, res => {
          const chunks = []; res.on('data', value => chunks.push(value));
          res.on('end', () => yes({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        }); req.on('error', no); req.end();
      });
      const allowed = [deploymentDefaults.appOrigin, deploymentDefaults.nodeOrigin].includes(origin);
      assert.equal(response.status, allowed ? 200 : 403, response.body);
      assert.equal(response.headers['access-control-allow-origin'], allowed ? origin : undefined);
    }
  } finally {
    if (server?.listening) await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
    await node?.close(); await rm(directory, { recursive: true, force: true });
  }
});
