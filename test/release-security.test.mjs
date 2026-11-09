import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { releaseEntries } from '../adapters/linux/verify-release.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
test('Linux release verification rejects traversal, missing runtime, duplicate and oversized files', () => {
  const entry = path => ({ path, bytes: 100, sha256: 'a'.repeat(64) });
  const files = ['bin/node', 'automesh-node', 'adapters/server/main.js', 'adapters/linux/setup.mjs'].map(entry);
  assert.equal(releaseEntries({ platform: 'linux-x64', files }).length, 4);
  for (const path of ['/etc/passwd', '../key', 'a/../key', 'a\\key', 'a//key', 'a/./key']) {
    assert.throws(() => releaseEntries({ platform: 'linux-x64', files: [...files, entry(path)] }), /invalid_release/);
  }
  for (const invalid of [files.slice(1), [...files, files[0]], [...files, { ...entry('x'), bytes: 200 * 1024 * 1024 }]]) {
    assert.throws(() => releaseEntries({ platform: 'linux-x64', files: invalid }), /invalid_release/);
  }
});
test('proxy exposes receiving and consent APIs while keeping control private', async () => {
  const source = await readFile(join(root, 'adapters/server/nginx.example.conf'), 'utf8');
  const pattern = source.match(/location ~ (\^\/\(node[^ ]+) \{/)[1];
  const allow = new RegExp(pattern);
  for (const path of ['/inbox/list', '/inbox/ack', '/inbox/file/parts', '/admin/connect/approve', '/admin/connect/poll', '/admin/members/remove']) assert.ok(allow.test(path), path);
  for (const path of ['/status', '/pair-code', '/members/remove', '/shutdown', '/admin/connect/approve/extra', '/inbox/list?x=1']) assert.ok(!allow.test(path), path);
  assert.match(source, /proxy_ssl_verify on/); assert.doesNotMatch(source, /proxy_pass[^;]*3004/);
});
test('Windows archive validation rejects tampering, traversal, duplicates and missing files without installation', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automesh-installer-test-'));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    const source = await readFile(join(root, 'adapters/windows/install.ps1'), 'utf8');
    const allowed = source.match(/\$taskAllowed = @\(([^\n]+)\)/)[1];
    const script = `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ErrorActionPreference = 'Stop'
$taskNames = @(${allowed})
foreach ($taskCase in @('valid','tampered','traversal','duplicate','missing','large-manifest')) {
  $taskZip = [IO.Compression.ZipFile]::Open((Join-Path ${quote(directory)} ($taskCase + '.zip')), [IO.Compression.ZipArchiveMode]::Create)
  try {
    $taskFiles = @{}
    foreach ($taskName in $taskNames) {
      if ($taskName -eq 'node-build.json') { continue }
      $taskBytes = [Text.Encoding]::UTF8.GetBytes('test-data')
      $taskHash = [Security.Cryptography.SHA256]::Create()
      try { $taskDigest = ([BitConverter]::ToString($taskHash.ComputeHash($taskBytes))).Replace('-','').ToLowerInvariant() } finally { $taskHash.Dispose() }
      $taskFiles[$taskName] = @{ bytes = $taskBytes.Length; sha256 = $taskDigest }
      if ($taskCase -eq 'missing' -and $taskName -eq 'node.exe') { continue }
      $taskEntryName = if ($taskCase -eq 'traversal' -and $taskName -eq 'node.exe') { '../node.exe' } else { $taskName }
      $taskEntry = $taskZip.CreateEntry($taskEntryName); $taskStream = $taskEntry.Open()
      try { $taskStream.Write($taskBytes,0,$taskBytes.Length) } finally { $taskStream.Dispose() }
    }
    if ($taskCase -eq 'tampered') { $taskFiles['node.exe'].sha256 = '0' * 64 }
    if ($taskCase -eq 'duplicate') { $taskEntry = $taskZip.CreateEntry('node.exe'); $taskStream = $taskEntry.Open(); try { $taskStream.WriteByte(1) } finally { $taskStream.Dispose() } }
    $taskJson = @{ files = $taskFiles } | ConvertTo-Json -Depth 5 -Compress
    if ($taskCase -eq 'large-manifest') { $taskJson += ' ' * 33000 }
    $taskBytes = [Text.Encoding]::UTF8.GetBytes($taskJson); $taskStream = $taskZip.CreateEntry('node-build.json').Open()
    try { $taskStream.Write($taskBytes,0,$taskBytes.Length) } finally { $taskStream.Dispose() }
  } finally { $taskZip.Dispose() }
}`;
    const fixture = join(directory, 'fixtures.ps1'); await writeFile(fixture, script);
    const created = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixture], { windowsHide: true, encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    for (const scenario of ['valid', 'tampered', 'traversal', 'duplicate', 'missing', 'large-manifest']) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'adapters/windows/install.ps1'), '-ValidatePayloadOnly', join(directory, scenario + '.zip')], { windowsHide: true, encoding: 'utf8' });
      assert.equal(result.status === 0, scenario === 'valid', scenario + ': ' + result.stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
