import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export { CONFIG_PURPOSE, COURIER_PURPOSE, PROTECTION, sealSecret, openSecret, readNodeConfig, protectNodeConfig } from '../../packages/runtime/src/secrets.js';

const CONFIG_PURPOSE = 'automesh-node-config-v1';
const COURIER_PURPOSE = 'automesh-node-courier-v1';
const purposes = new Set([CONFIG_PURPOSE, COURIER_PURPOSE]);

// Secret bytes travel only through anonymous pipes, not command arguments,
// environment variables, temporary plaintext files or diagnostic logs.
export function windowsSecretProtector({ platform = process.platform, helper } = {}) {
  if (platform !== 'win32') throw new Error('node_secret_protection_unavailable');
  helper ??= process.argv[1]?.endsWith('.cjs')
    ? join(dirname(process.argv[1]), 'secret-store.ps1')
    : fileURLToPath(new URL('./secret-store.ps1', import.meta.url));
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const transform = (operation, purpose, data) => new Promise((resolve, reject) => {
    if (!purposes.has(purpose) || typeof data !== 'string' || data.length > 24000) { reject(new Error('invalid_node_secret')); return; }
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Pipe'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, 15000); timer.unref();
    child.stdout.on('data', chunk => { output += chunk.toString('ascii'); if (output.length > 32768) { failed = true; child.kill(); } });
    child.stderr.on('data', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.once('error', () => { clearTimeout(timer); reject(new Error('node_secret_protection_failed')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0 || !output || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)) reject(new Error('node_secret_protection_failed'));
      else resolve(output);
    });
    child.stdin.end(JSON.stringify({ operation, purpose, data }));
  });
  return Object.freeze({
    protection: 'windows-dpapi-current-user',
    protect: (bytes, purpose) => transform('protect', purpose, Buffer.from(bytes).toString('base64')),
    unprotect: async (cipher, purpose) => Buffer.from(await transform('unprotect', purpose, cipher), 'base64'),
  });
}
