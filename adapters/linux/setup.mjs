import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { personalNodeConfig, createPersonalNode } from './personal-node.js';
import { text } from './language.mjs';
import { deploymentDefaults } from '../../packages/deployment/src/defaults.js';

if (process.platform !== 'linux' || !process.stdin.isTTY) throw new Error('interactive_linux_required');
const prompt = createInterface({ input: process.stdin, output: process.stdout });
let language = 'en';
try {
  const choice = (await prompt.question('Interface language / Язык [en/ru, default en]: ')).trim();
  if (choice && !['en', 'ru'].includes(choice)) throw new Error('invalid_ui_language');
  language = choice || 'en';
  process.stdout.write(text(language, 'intro'));
  const publicUrl = (await prompt.question(text(language, 'url'))).trim();
  const portText = (await prompt.question(text(language, 'port'))).trim(); const port = portText ? Number(portText) : 3003;
  const appOrigin = (await prompt.question(text(language, 'app'))).trim() || deploymentDefaults.appOrigin;
  const certPath = (await prompt.question(text(language, 'cert'))).trim();
  const keyPath = (await prompt.question(text(language, 'key'))).trim();
  const root = join(homedir(), 'AutomeshNode');
  personalNodeConfig(root, publicUrl, port, appOrigin);
  process.stdout.write(text(language, 'preview', { url: publicUrl, root }));
  if ((await prompt.question(text(language, 'confirm'))).trim() !== 'YES') { process.stdout.write(text(language, 'cancel')); }
  else {
    await createPersonalNode({ root, publicUrl, port, certPath, keyPath, appOrigin });
    process.stdout.write(text(language, 'done'));
  }
} catch { process.stderr.write(text(language, 'failure')); process.exitCode = 1; }
finally { prompt.close(); }
