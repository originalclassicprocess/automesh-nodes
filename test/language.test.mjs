import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages, text } from '../adapters/linux/language.mjs';
import { personalNodeConfig } from '../adapters/linux/personal-node.js';
test('Linux setup has both language variants without translating addresses or commands', () => {
  for (const key of Object.keys(messages)) {
    assert.ok(text('en', key)); assert.ok(text('ru', key));
  }
  const url = 'https://node.example:3003', root = '/home/test/AutomeshNode';
  for (const language of ['en', 'ru']) {
    assert.ok(text(language, 'preview', { url, root }).includes(url));
    assert.ok(text(language, 'preview', { url, root }).includes(root));
    assert.ok(text(language, 'done').includes('./automesh-node start'));
    assert.ok(text(language, 'confirm').includes('YES'));
  }
  assert.throws(() => text('fr', 'intro')); assert.throws(() => text('en', '__proto__'));
});
test('new Linux nodes allow a custom app domain without weakening origin checks', { skip: process.platform !== 'linux' }, () => {
  const root = '/home/test/AutomeshNode';
  assert.deepEqual(personalNodeConfig(root, 'https://node.example', 3003, 'https://chat.example').allowedOrigins, ['https://chat.example']);
  for (const origin of ['http://chat.example', 'https://chat.example/path', '*', 'https://user:secret@chat.example'])
    assert.throws(() => personalNodeConfig(root, 'https://node.example', 3003, origin));
});
