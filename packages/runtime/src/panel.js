import { randomBytes } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { equalToken } from './auth.js';
import { sealSecret, openSecret } from './secrets.js';
import { writeAtomic } from './files.js';
import { isValidAccountId } from '../../protocol/src/bech32m.js';
import QRCode from 'qrcode';

const PURPOSE = 'automesh-node-panel-admin-v1';
const COOKIE = '__Host-AutomeshNode';
const token = size => randomBytes(size).toString('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export async function createAdminPanel({ directory, protector, publicUrl, appUrl, now = Date.now, mustExist = false }) {
  const canonical = value => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid_panel_url'); return url.origin; };
  publicUrl = canonical(publicUrl); appUrl = canonical(appUrl);
  const path = join(directory, 'panel-admin.json');
  let owner = null, failed = false;
  async function save(next) {
    try { await writeAtomic(directory, 'panel-admin.json', await sealSecret({ owner: next }, PURPOSE, protector)); owner = next; }
    catch (error) { failed = true; throw error; }
  }
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 24000) throw new Error('invalid_panel_admin');
    const saved = await openSecret(JSON.parse(await readFile(path, 'utf8')), PURPOSE, protector);
    if (!exact(saved, ['owner']) || saved.owner !== null && (!exact(saved.owner, ['address', 'publicKey']) || !isValidAccountId(saved.owner.address) || !/^04[a-f0-9]{128}$/.test(saved.owner.publicKey))) throw new Error('invalid_panel_admin');
    owner = saved.owner;
  } catch (error) { if (error.code !== 'ENOENT') throw error; if (mustExist) throw new Error('panel_admin_missing'); await save(null); }
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', await readFile(new URL('../../../ui/panel.html', import.meta.url))]],
    ['/panel.mjs', ['text/javascript; charset=utf-8', await readFile(new URL('../../../ui/panel.mjs', import.meta.url))]],
    ['/panel.css', ['text/css; charset=utf-8', await readFile(new URL('../../../ui/panel.css', import.meta.url))]]
  ]);
  const tickets = new Map(), sessions = new Map();
  let bootstrap = '', bootstrapExpires = 0;
  const sweep = () => {
    for (const [id, item] of tickets) if (item.expiresAt <= now()) tickets.delete(id);
    for (const [id, item] of sessions) if (item.expiresAt <= now()) sessions.delete(id);
  };
  const clearCookie = response => response.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" }); response.end(JSON.stringify(value)); };
  async function body(request) {
    if (request.headers['content-type'] !== 'application/json') throw new Error('panel_denied');
    const parts = []; let size = 0;
    for await (const part of request) { size += part.length; if (size > 2048) throw new Error('panel_denied'); parts.push(part); }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  return {
    publicUrl,
    get configured() { return Boolean(owner); },
    setup() {
      if (failed || owner) throw new Error('panel_setup_denied');
      bootstrap = token(16); bootstrapExpires = now() + 600000;
      return { code: bootstrap, expiresAt: bootstrapExpires, url: publicUrl };
    },
    async approve(identity, value, nodeId) {
      sweep();
      if (failed || !exact(value, ['publicUrl', 'ticket', 'scope', 'code']) || value.publicUrl !== publicUrl || value.scope !== 'node-admin-v1') throw new Error('unauthorized');
      const ticket = tickets.get(value.ticket);
      if (!ticket || ticket.approved) throw new Error('unauthorized');
      if (owner) {
        if (identity.address !== owner.address || identity.publicKey !== owner.publicKey) throw new Error('unauthorized');
      } else {
        if (!bootstrap || bootstrapExpires <= now() || !equalToken(value.code, bootstrap)) throw new Error('unauthorized');
        await save({ ...identity }); bootstrap = ''; bootstrapExpires = 0;
      }
      ticket.approved = true;
      return { approved: true, nodeId, publicUrl };
    },
    async handle(request, response, actions) {
      const asset = assets.get(request.url);
      if (request.method === 'GET' && asset) {
        response.writeHead(200, { 'Content-Type': asset[0], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }); response.end(asset[1]); return true;
      }
      if (!request.url.startsWith('/admin/') || request.url === '/admin/connect/approve') return false;
      try {
        sweep();
        if (failed || request.method !== 'POST' || request.headers.origin !== publicUrl) throw new Error('panel_denied');
        const value = await body(request);
        if (request.url === '/admin/connect/start') {
          if (!exact(value, []) || tickets.size >= 64) throw new Error('panel_denied');
          const id = token(16), pollToken = token(32), expiresAt = now() + 120000;
          tickets.set(id, { pollToken, expiresAt, approved: false });
          // Only the approving link is shared. Poll token stays in the requesting tab.
          const link = new URL(appUrl); link.searchParams.set('nodeAdmin', publicUrl); link.searchParams.set('nodeId', actions.nodeId); link.searchParams.set('ticket', id); link.searchParams.set('expiresAt', String(expiresAt));
          json(response, 200, { ticket: id, pollToken, expiresAt, configured: Boolean(owner), link: link.href,
            qr: await QRCode.toDataURL(link.href, { width: 240, margin: 2 }) }); return true;
        }
        if (request.url === '/admin/connect/poll') {
          if (!exact(value, ['ticket', 'pollToken'])) throw new Error('panel_denied');
          const ticket = tickets.get(value.ticket);
          if (!ticket || ticket.session || !equalToken(value.pollToken, ticket.pollToken)) throw new Error('panel_denied');
          if (!ticket.approved) { json(response, 200, { approved: false }); return true; }
          if (sessions.size >= 64) throw new Error('panel_denied');
          const id = token(32), csrf = token(32), expiresAt = now() + 900000;
          ticket.session = id;
          sessions.set(id, { csrf, expiresAt });
          response.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`);
          json(response, 200, { approved: true }); return true;
        }
        if (request.url === '/admin/connect/cancel') {
          if (!exact(value, ['ticket', 'pollToken'])) throw new Error('panel_denied');
          const ticket = tickets.get(value.ticket);
          if (!ticket || !equalToken(value.pollToken, ticket.pollToken)) throw new Error('panel_denied');
          tickets.delete(value.ticket); if (ticket.session) { sessions.delete(ticket.session); clearCookie(response); }
          json(response, 200, { cancelled: true }); return true;
        }
        const cookies = (request.headers.cookie ?? '').split(';').map(item => item.trim());
        const id = cookies.find(item => item.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
        const session = sessions.get(id);
        if (!session) throw new Error('panel_denied');
        if (request.url === '/admin/status' && exact(value, [])) {
          json(response, 200, { ...actions.status(), admin: owner.address, csrf: session.csrf, sessionExpiresAt: session.expiresAt,
            publicUrl, signalingUrl: `${publicUrl.replace('https:', 'wss:')}/signal` }); return true;
        }
        if (!equalToken(request.headers['x-automesh-csrf'], session.csrf)) throw new Error('panel_denied');
        if (request.url === '/admin/logout' && exact(value, [])) { sessions.delete(id); clearCookie(response); json(response, 200, { loggedOut: true }); return true; }
        if (request.url === '/admin/invite' && exact(value, [])) {
          const invitation = await actions.invite();
          const invite = { protocol: 'automesh-node-pair-v1', url: publicUrl, nodeId: actions.nodeId, code: invitation.pairCode, expiresAt: invitation.pairExpires };
          json(response, 200, { invitation: invite, qr: await QRCode.toDataURL(JSON.stringify(invite), { width: 280, margin: 2 }) }); return true;
        }
        if (request.url === '/admin/members/remove' && exact(value, ['address', 'confirm']) && isValidAccountId(value.address) && value.confirm === 'remove-node-data') {
          json(response, 200, await actions.remove(value.address)); return true;
        }
        throw new Error('panel_denied');
      } catch { json(response, 403, { error: 'panel_denied' }); return true; }
    },
    close() { tickets.clear(); sessions.clear(); bootstrap = ''; }
  };
}
