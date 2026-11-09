import { Server } from 'node:net';
import { open, readlink, lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export async function verifyUnixListener(server, inheritedPath) {
  if (typeof Server.prototype.address.call(server) === 'string') return true;
  // LiteSpeed can pass the Unix listener as stdin fd 0. Node's public address()
  // has no pathname for inherited Pipe handles. Do NOT trust LS's decorated
  // address() / an env pathname alone: match the actual fd's socket inode to
  // the kernel Unix-listener table and to the configured hosting socket path.
  // _handle.fd is used only in this pinned Node hosting adapter, not the core.
  if (server._handle?.fd !== 0 || !server.listening) return false;
  return verifyInheritedUnixDescriptor(inheritedPath);
}
export async function verifyInheritedUnixDescriptor(inheritedPath) {
  if (process.platform !== 'linux' || typeof inheritedPath !== 'string' ||
      !isAbsolute(inheritedPath) || resolve(inheritedPath) !== inheritedPath || inheritedPath.length > 255) return false;
  try {
    const link = await readlink('/proc/self/fd/0'), inode = /^socket:\[([0-9]+)\]$/.exec(link)?.[1];
    if (!inode || !(await lstat(inheritedPath)).isSocket()) return false;
    const handle = await open('/proc/net/unix', 'r'), buffer = Buffer.alloc(1024 * 1024);
    let used = 0;
    try {
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break; used += bytesRead;
      }
    } finally { await handle.close(); }
    if (used === buffer.length) return false;
    return buffer.subarray(0, used).toString('utf8').split('\n').some(line => {
      const columns = line.trim().split(/\s+/);
      return columns.length === 8 && columns[6] === inode && columns[7] === inheritedPath && columns[4] === '0001' && columns[3] === '00010000';
    });
  } catch { return false; }
}
