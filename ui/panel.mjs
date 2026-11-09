const el = id => document.getElementById(id);
const ru = {
  'My node':'Моя нода', 'Sign out':'Выйти', 'Manage through Automesh':'Управление через Automesh',
  'Your password and seed stay in the app. Only approve the sign-in here.':'Пароль и seed остаются в приложении. Здесь нужно только подтвердить вход.',
  'Sign in through Automesh':'Войти через Automesh', 'Open approval in Automesh':'Открыть подтверждение в Automesh',
  'Cancel':'Отмена', 'Connection':'Связь', 'Queue':'Очередь', 'Profiles':'Профили', 'Connect a client':'Подключить клиент',
  'Signaling':'Сигналинг', 'Copy address':'Копировать адрес', 'New profile invitation':'Новое приглашение профиля',
  "Paste into the app's node settings":'Вставьте в настройках ноды приложения', 'Copy invitation':'Копировать приглашение',
  'Single-use invitation, valid for 10 minutes. Share only with your own profile.':'Приглашение одноразовое, действует 10 минут. Передавайте только своему профилю.',
  'Linked profiles':'Привязанные профили', 'Node information':'Информация о ноде', 'Refresh':'Обновить',
  'Signaling helps devices find each other. A separate invitation grants a profile access to the queue.':'Сигналинг помогает устройствам найти друг друга. Приглашение отдельно даёт профилю доступ к очереди.',
  'The node stores encrypted data. To receive it, open Automesh and connect to this signaling server. Automatic transfer between separate nodes is not implemented yet.':'Нода хранит зашифрованные данные. Для доставки получатель должен открыть Automesh и подключиться к этому сигналингу. Автоматическая передача между разными нодами пока не реализована.',
  'Connecting…':'Подключаемся…', 'Signaling enabled · clients: {n}':'Сигналинг включён · клиентов: {n}', 'Signaling disabled':'Сигналинг выключен',
  '{n} envelopes · {used} / {max}':'{n} конвертов · {used} / {max}', '{n} of {max}':'{n} из {max}', 'MB':'МБ',
  'Files: {n} / {max} · uploading: {uploading}':'Файлы: {n} / {max} · загружаются: {uploading}',
  'Used or reserved: {used} / {max}. New files leave {reserve} for messages.':'Занято или зарезервировано: {used} / {max}. Новые файлы оставляют {reserve} для сообщений.',
  'File slots and storage are separate limits. Partial uploads without progress expire after 1 hour; accepted files wait for a receipt or their delivery expiry.':'Файловые слоты и объём — отдельные лимиты. Незавершённые загрузки без прогресса освобождаются через 1 час; принятые файлы ждут квитанцию или истечение срока доставки.',
  'Files: {n} / {max} per profile · uploading: {uploading}':'Файлы: {n} / {max} на профиль · загружаются: {uploading}',
  'To recipient: {out} · in mailbox: {messages} · files: {files}':'К получателю: {out} · в ящике: {messages} · файлов: {files}',
  'Disconnect profile':'Отключить профиль',
  'Disconnect this profile and delete its node queue? App history stays. Node ownership is not transferred.':'Отключить этот профиль и удалить его очередь на ноде? История в приложении сохранится. Управление нодой не передаётся.',
  'Administrator: {admin}\nID: {id}\nAddress: {url}\nFile: up to 20 MB\nSession until: {expires}':'Администратор: {admin}\nID: {id}\nАдрес: {url}\nФайл: до 20 МБ\nСессия: до {expires}',
  'Node running. Management available.':'Нода работает. Управление доступно.',
  'Action failed. Check the connection or approve sign-in again.':'Не удалось выполнить действие. Проверьте связь или подтвердите вход снова.',
  'Verification code: {code}':'Код сверки: {code}',
  'Approve with the administrator profile. Request expires in 2 minutes.':'Подтвердите вход профилем администратора. Запрос действует 2 минуты.',
  'First sign-in: obtain the administrator setup code from the server owner. Do not use a profile pairing code.':'Первый вход: получите код назначения администратора у владельца сервера. Не используйте код привязки профиля.',
  'Waiting for approval. Check the node address in Automesh.':'Ждём подтверждения. В Automesh проверьте адрес ноды.',
  'Request expired. Start sign-in again.':'Запрос истёк. Нажмите «Войти» заново.',
  'Request closed. Try signing in again.':'Запрос завершён. Повторите вход.', 'Signed out of the panel.':'Вы вышли из панели.',
  'Approve sign-in again.':'Подтвердите вход заново.', 'New invitation ready. The previous one is no longer valid.':'Новое приглашение готово. Предыдущее больше не действует.',
  'Address copied.':'Адрес скопирован.', 'Invitation copied.':'Приглашение скопировано.', 'Sign in to manage the node.':'Войдите, чтобы управлять нодой.',
  'Sign-in approval QR':'QR подтверждения входа', 'Profile pairing QR':'QR привязки профиля'
};
let language = 'en', statusValue = null, noticeValue = ['Connecting…', {}];
try { if (globalThis.localStorage?.getItem('automesh.node-language.v1') === 'ru') language = 'ru'; } catch {}
function t(key, values = {}) { return (language === 'ru' ? ru[key] ?? key : key).replace(/\{([a-z]+)\}/g, (_match, name) => String(values[name] ?? '')); }
function applyLanguage() {
  if (document.documentElement) document.documentElement.lang = language;
  document.title = t('My node') + ' · Automesh';
  for (const element of document.querySelectorAll?.('[data-i18n]') ?? []) element.textContent = t(element.dataset.i18n);
  el('languageEn').setAttribute?.('aria-pressed', String(language === 'en'));
  el('languageRu').setAttribute?.('aria-pressed', String(language === 'ru'));
  el('approvalQr').alt = t('Sign-in approval QR'); el('inviteQr').alt = t('Profile pairing QR');
  if (statusValue) renderStatus(statusValue);
  if (pending) renderApproval(pending);
  note(...noticeValue);
}
function chooseLanguage(value) { language = value; try { globalThis.localStorage?.setItem('automesh.node-language.v1', value); } catch {} applyLanguage(); }
el('languageEn').onclick = () => chooseLanguage('en'); el('languageRu').onclick = () => chooseLanguage('ru');
let csrf = '', pending = null, timer, busy = false;
async function api(path, value = {}) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Automesh-CSRF': csrf } : {}) }, body: JSON.stringify(value), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('denied'); return response.json();
}
function note(text, values = {}) { noticeValue = [text, values]; el('notice').textContent = t(text, values); }
function cancel(revoke = true) {
  const previous = pending; clearTimeout(timer); pending = null; el('approval').hidden = true; el('connect').disabled = false;
  if (revoke && previous) void api('/admin/connect/cancel', { ticket: previous.ticket, pollToken: previous.pollToken }).catch(() => {});
  el('approvalLink').removeAttribute('href'); el('approvalQr').removeAttribute('src');
}
function locked() { csrf = ''; statusValue = null; cancel(); el('login').hidden = false; el('dashboard').hidden = true; el('logout').hidden = true; el('inviteValue').value = ''; el('inviteQr').removeAttribute('src'); el('invitation').hidden = true; }
const mb = bytes => `${(bytes / 1048576).toFixed(1)} ${t('MB')}`;
async function refresh() {
  const value = await api('/admin/status'); csrf = value.csrf;
  statusValue = value; renderStatus(value); note('Node running. Management available.');
}
function renderStatus(value) {
  el('login').hidden = true; el('dashboard').hidden = false; el('logout').hidden = false;
  el('signal').value = value.signalingUrl;
  el('connection').textContent = value.signaling.enabled ? t('Signaling enabled · clients: {n}', { n: value.signaling.clients }) : t('Signaling disabled');
  el('queue').textContent = t('{n} envelopes · {used} / {max}', { n: value.messages, used: mb(value.bytes), max: mb(value.maxBytes) });
  const files = value.courier?.attachments;
  if (files && Number.isInteger(files.maxFiles)) {
    for (const text of [
      t('Files: {n} / {max} · uploading: {uploading}', { n: files.files, max: files.maxFiles, uploading: files.uploading }),
      t('Used or reserved: {used} / {max}. New files leave {reserve} for messages.', { used: mb(value.bytes), max: mb(value.maxBytes), reserve: mb(value.textReservedBytes ?? 0) }),
      t('File slots and storage are separate limits. Partial uploads without progress expire after 1 hour; accepted files wait for a receipt or their delivery expiry.')
    ]) { const detail = document.createElement('span'); detail.style = 'display:block;margin-top:.5em'; detail.textContent = text; el('queue').append(detail); }
  }
  el('capacity').textContent = t('{n} of {max}', { n: value.members.length, max: value.memberLimit });
  el('members').replaceChildren();
  for (const member of value.members) {
    const row = document.createElement('article'); row.className = 'member';
    const address = document.createElement('code'); address.textContent = member.address;
    const status = document.createElement('p'); status.textContent = t('To recipient: {out} · in mailbox: {messages} · files: {files}', { out: member.outgoing, messages: member.messages, files: member.files });
    const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = t('Disconnect profile');
    remove.onclick = () => perform(async () => {
      if (!confirm(t('Disconnect this profile and delete its node queue? App history stays. Node ownership is not transferred.'))) return;
      await api('/admin/members/remove', { address: member.address, confirm: 'remove-node-data' }); await refresh();
    }); row.append(address, status);
    if (Number.isInteger(member.filesLimit)) { const files = document.createElement('p');
      files.textContent = t('Files: {n} / {max} per profile · uploading: {uploading}', { n: member.files, max: member.filesLimit, uploading: member.uploadingFiles }); row.append(files); }
    row.append(remove); el('members').append(row);
  }
  el('details').textContent = t('Administrator: {admin}\nID: {id}\nAddress: {url}\nFile: up to 20 MB\nSession until: {expires}', { admin: value.admin, id: value.nodeId, url: value.publicUrl, expires: new Date(value.sessionExpiresAt).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-US') });
}
async function perform(work) {
  if (busy) return; busy = true;
  try { await work(); } catch { note('Action failed. Check the connection or approve sign-in again.'); }
  finally { busy = false; }
}
el('connect').onclick = () => perform(async () => {
  cancel(); pending = await api('/admin/connect/start'); const current = pending;
  el('connect').disabled = true; el('approval').hidden = false; el('approvalLink').href = current.link;
  renderApproval(current); el('approvalQr').src = current.qr;
  note('Waiting for approval. Check the node address in Automesh.');
  const poll = async () => {
    if (pending !== current) return;
    if (Date.now() >= current.expiresAt) { cancel(); note('Request expired. Start sign-in again.'); return; }
    try { const reply = await api('/admin/connect/poll', { ticket: current.ticket, pollToken: current.pollToken });
      if (pending !== current) return;
      if (reply.approved) { cancel(false); await refresh(); return; }
    } catch { if (pending === current) { cancel(); note('Request closed. Try signing in again.'); } return; }
    timer = setTimeout(poll, 2000);
  }; timer = setTimeout(poll, 1000);
});
el('cancel').onclick = () => cancel();
el('logout').onclick = () => perform(async () => { await api('/admin/logout'); locked(); note('Signed out of the panel.'); });
el('refresh').onclick = () => perform(async () => { try { await refresh(); } catch { locked(); note('Approve sign-in again.'); } });
el('invite').onclick = () => perform(async () => { const value = await api('/admin/invite'); el('inviteValue').value = JSON.stringify(value.invitation); el('inviteQr').src = value.qr; el('invitation').hidden = false; note('New invitation ready. The previous one is no longer valid.'); });
el('copySignal').onclick = () => perform(async () => { await navigator.clipboard.writeText(el('signal').value); note('Address copied.'); });
el('copyInvite').onclick = () => perform(async () => { await navigator.clipboard.writeText(el('inviteValue').value); note('Invitation copied.'); });
addEventListener('pagehide', cancel);
function renderApproval(value) {
  el('compare').textContent = t('Verification code: {code}', { code: value.ticket.slice(0, 6).toUpperCase() });
  el('setupHint').textContent = t(value.configured ? 'Approve with the administrator profile. Request expires in 2 minutes.' : 'First sign-in: obtain the administrator setup code from the server owner. Do not use a profile pairing code.');
}
applyLanguage();
refresh().catch(() => { locked(); note('Sign in to manage the node.'); });
