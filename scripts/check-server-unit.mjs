import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux') throw new Error('linux_required');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'automesh-unit-'));
try {
  // Only deployment paths change for syntax verification. No service is enabled
  // or started, and the repository template is not modified.
  const unit = (await readFile(join(root, 'adapters/server/automesh-node.service'), 'utf8'))
    .replaceAll('/opt/automesh-nodes', root).replace('ExecStart=/usr/bin/node ', `ExecStart=${process.execPath} `);
  const target = join(temporary, 'automesh-node.service'); await writeFile(target, unit);
  await promisify(execFile)('systemd-analyze', ['verify', '--man=no', target]);
  console.log('systemd unit syntax verified (not installed or started)');
} finally { await rm(temporary, { recursive: true, force: true }); }
