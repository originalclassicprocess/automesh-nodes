import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { validateNodeConfig, nodeListenAddresses } from '../adapters/windows/runner.js';

const base = { version: 1, lanAddress: '192.168.2.5', port: 3003, controlPort: 3004,
  dataDirectory: resolve('fixture-data'), pfxFile: resolve('fixture.pfx'), pfxPassword: 'fixture-only',
  adminToken: 'a'.repeat(64), maxBytes: 64 * 1024 * 1024 };
const interfaces = { wifi: [{ address: base.lanAddress }], ethernet: [{ address: '10.0.0.3' }], public: [{ address: '203.0.113.5' }] };

test('multiple explicit private interfaces and loopback use one node configuration', () => {
  const config = { ...base, networkMode: 'automatic', lanAddresses: [base.lanAddress, '10.0.0.3'] };
  assert.equal(validateNodeConfig(config, interfaces), config);
  assert.deepEqual(nodeListenAddresses(config), ['127.0.0.1', base.lanAddress, '10.0.0.3']);
});
test('an automatic node can stay available locally with no home interface', () => {
  const config = { ...base, networkMode: 'automatic', lanAddress: '', lanAddresses: [] };
  assert.equal(validateNodeConfig(config, {}), config);
  assert.deepEqual(nodeListenAddresses(config), ['127.0.0.1']);
  assert.throws(() => validateNodeConfig({ ...config, networkMode: 'manual' }, {}));
});
test('a truncated preferred address has a distinct, non-sensitive startup error', () => {
  assert.throws(() => validateNodeConfig({ ...base, lanAddress: '1', networkMode: 'automatic', lanAddresses: [base.lanAddress] }, interfaces),
    { message: 'invalid_node_primary_address' });
});
test('invalid, vanished, duplicate and unrestricted bindings fail closed', () => {
  for (const lanAddresses of [['0.0.0.0'], ['203.0.113.5'], ['192.168.2.6'], [base.lanAddress, base.lanAddress], ['127.0.0.1'], '10.0.0.3', [null]]) {
    assert.throws(() => validateNodeConfig({ ...base, networkMode: 'automatic', lanAddresses }, interfaces));
  }
  assert.throws(() => validateNodeConfig({ ...base, networkMode: 'any' }, interfaces));
  assert.throws(() => validateNodeConfig({ ...base, lanAddresses: ['10.0.0.3'] }, interfaces));
  assert.equal(validateNodeConfig(base, interfaces), base); // existing installs
});
