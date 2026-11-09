import { deploymentDefaults } from '../../packages/deployment/src/defaults.js';
export const messages = {
  intro: ['Automesh Node · first setup\nYou need your valid HTTPS certificate. Do not enter your Automesh seed or password.\n', 'Automesh Node · первый запуск\nНужен ваш действующий HTTPS-сертификат. Seed и пароль Automesh не вводятся.\n'],
  url: ['Full node HTTPS URL (domain and port): ', 'Полный HTTPS-адрес ноды (домен и порт): '],
  port: ['HTTPS port [3003]: ', 'Порт HTTPS [3003]: '],
  app: [`App HTTPS origin [${deploymentDefaults.appOrigin}]: `, `HTTPS-адрес приложения [${deploymentDefaults.appOrigin}]: `],
  cert: ['Absolute path to a regular certificate PEM file (not a symlink): ', 'Абсолютный путь к обычному PEM-файлу сертификата (не симлинк): '],
  key: ['Absolute path to the private PEM key (owned by you, mode 600): ', 'Абсолютный путь к приватному PEM-ключу (владелец вы, права 600): '],
  preview: ['\nNew node: {url}\nData: {root}\nHTTPS listens on the network; management stays on 127.0.0.1.\nFirewall, router and services are NOT changed.\n', '\nНовая нода: {url}\nДанные: {root}\nHTTPS слушает сеть, управление остаётся только 127.0.0.1.\nFirewall, роутер и службы НЕ меняются.\n'],
  confirm: ['Create a new node? Type YES: ', 'Создать новую ноду? Введите YES: '],
  cancel: ['Cancelled.\n', 'Отменено.\n'],
  done: ['Ready. Run ./automesh-node start. In another terminal: ./automesh-node admin-setup.\nOpen the node URL, choose Sign in and approve with your Automesh profile.\nKeep a separate backup of master.key; renew TLS before it expires.\n', 'Готово. Запустите ./automesh-node start. В другом терминале: ./automesh-node admin-setup.\nОткройте адрес ноды, нажмите «Войти» и подтвердите свой профиль в Automesh.\nХраните резервную копию master.key отдельно; обновляйте TLS-сертификат до истечения срока.\n'],
  failure: ['Setup stopped: check URL, certificate, permissions and the existing AutomeshNode directory. Nothing was deleted; do not reinitialize an existing node.\n', 'Настройка остановлена: проверьте адрес, сертификат, права и существующий каталог AutomeshNode. Ничего не удалено; существующую ноду не переинициализируйте.\n']
};
export function text(language, key, values = {}) {
  if (!['en', 'ru'].includes(language) || !Object.hasOwn(messages, key)) throw new Error('invalid_ui_language_or_key');
  return messages[key][language === 'ru' ? 1 : 0].replace(/\{([a-z]+)\}/g, (_part, name) => String(values[name] ?? ''));
}
