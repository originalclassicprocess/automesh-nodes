import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Automated interaction smoke test, no browser credentials or production node.
test('panel renders text safely, starts explicit approval, imports an invitation and logs out', async () => {
  const elements = new Map(), requests = [], schedules = [];
  const element = () => ({ hidden: false, textContent: '', value: '', children: [], removeAttribute(key) { delete this[key]; }, replaceChildren() { this.children = []; }, append(...children) { this.children.push(...children); } });
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  let authorized = false;
  const status = { csrf: 'csrf', signalingUrl: 'wss://node.example/signal', signaling: { enabled: true, clients: 2 }, messages: 3, bytes: 20, maxBytes: 67108864,
    courier: { attachments: { files: 16, maxFiles: 128, uploading: 2 } }, textReservedBytes: 8388608,
    members: [{ address: '<img onerror=bad>', outgoing: 2, messages: 1, files: 1, filesLimit: 16, uploadingFiles: 1 }], memberLimit: 8, admin: 'admin', nodeId: 'node', publicUrl: 'https://node.example', sessionExpiresAt: Date.now() + 900000 };
  const source = await readFile(new URL('../ui/panel.mjs', import.meta.url), 'utf8');
  runInNewContext(source, { document: { getElementById: get, createElement: element }, AbortSignal, Date,
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (path === '/admin/status') return { ok: authorized, json: async () => status };
      if (path === '/admin/connect/start') return { ok: true, json: async () => ({ ticket: 'abcdef' + '1'.repeat(26), pollToken: 'secret', expiresAt: Date.now() + 120000, configured: false, link: 'https://automesh.space/?request', qr: 'data:image/png;base64,qr' }) };
      if (path === '/admin/connect/poll') { authorized = true; return { ok: true, json: async () => ({ approved: true }) }; }
      if (path === '/admin/invite') return { ok: true, json: async () => ({ invitation: { protocol: 'automesh-node-pair-v1', code: 'invitation' }, qr: 'data:image/png;base64,qr' }) };
      if (path === '/admin/logout') { authorized = false; return { ok: true, json: async () => ({ loggedOut: true }) }; }
      throw new Error('unexpected_route');
    }, navigator: { clipboard: { writeText: async () => {} } }, confirm: () => true,
    setTimeout: callback => { schedules.push(callback); return schedules.length; }, clearTimeout() {}, addEventListener() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1); assert.equal(get('login').hidden, false);
  await get('connect').onclick(); assert.equal(get('approval').hidden, false); assert.match(get('compare').textContent, /ABCDEF/);
  assert.equal(get('approvalLink').href, 'https://automesh.space/?request');
  await schedules.pop()(); assert.equal(get('dashboard').hidden, false);
  assert.equal(get('members').children[0].children[0].textContent, '<img onerror=bad>');
  assert.match(get('queue').textContent, /envelopes/);
  assert.match(get('queue').children[0].textContent, /16 \/ 128.*uploading: 2/);
  assert.match(get('members').children[0].children[2].textContent, /1 \/ 16 per profile/);
  await get('invite').onclick(); assert.equal(JSON.parse(get('inviteValue').value).code, 'invitation');
  assert.equal(requests.at(-1).options.headers['X-Automesh-CSRF'], 'csrf');
  const count = requests.length, invitation = get('inviteValue').value;
  get('languageRu').onclick(); assert.match(get('queue').textContent, /конвертов/);
  assert.match(get('queue').children.at(-3).textContent, /Файлы: 16 \/ 128/);
  assert.equal(requests.length, count); assert.equal(get('inviteValue').value, invitation);
  assert.equal(get('members').children[0].children[0].textContent, '<img onerror=bad>');
  get('languageEn').onclick(); assert.match(get('queue').textContent, /envelopes/); assert.equal(requests.length, count);
  await get('logout').onclick(); assert.equal(get('dashboard').hidden, true); assert.equal(get('inviteValue').value, '');
});
