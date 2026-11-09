import { constants } from 'node:fs';
import { open, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export function requireLinux() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') throw new Error('linux_required');
}
const owned = info => info.uid === process.getuid() || info.uid === 0;
export async function safeParents(path) {
  requireLinux();
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('unsafe_server_path');
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    // A root-owned sticky /tmp ancestor is safe beneath our private directory.
    const sticky = info.uid === 0 && Boolean(info.mode & 0o1000);
    if (!info.isDirectory() || info.isSymbolicLink() || !owned(info) || ((info.mode & 0o022) && !sticky)) throw new Error('unsafe_server_parent');
    if (dirname(parent) === parent) break;
  }
}
export async function readSafeFile(path, { privateFile = true, limit = 32768 } = {}) {
  await safeParents(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || !owned(info) || info.size > limit ||
        (info.mode & (privateFile ? 0o077 : 0o022))) throw new Error('unsafe_server_file');
    const value = await handle.readFile();
    if (value.length > limit) throw new Error('unsafe_server_file');
    return value;
  } finally { await handle.close(); }
}
export async function ensureDataDirectory(path) {
  await safeParents(path);
  await mkdir(path, { mode: 0o700 });
}
export async function checkDataDirectory(path) {
  await safeParents(path);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('unsafe_server_data');
}
export async function acquireDataLock(directory) {
  await checkDataDirectory(directory);
  const handle = await open(resolve(directory, '.writer.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('unsafe_server_lock');
    // Linux flock is attached to the shared open-file description. The parent
    // retains it after this helper exits; SIGKILL releases it in the kernel.
    await new Promise((yes, no) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
      child.once('error', () => no(new Error('server_lock_unavailable')));
      child.once('exit', code => code === 0 ? yes() : no(new Error('server_data_in_use')));
    });
    return () => handle.close();
  } catch (error) { await handle.close(); throw error; }
}
