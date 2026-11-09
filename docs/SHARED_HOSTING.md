# Нода на shared-хостинге — preview

Актуальная схема чистого запуска: [CLEAN_START.md](CLEAN_START.md). Мессенджер
`https://automesh.online`, нода `https://automesh.space`; DNS не меняется сборкой.

Это отдельный adapter, не замена VPS/systemd runner. Wire v1, подписи,
защита очередей, 20 МиБ на файл и восемь привязок остаются прежними.
Клиент поддерживает HTTPS-адрес ноды; особенности этого адаптера относятся к
размещению за HTTPS-фронтендом shared-хостинга.

## Границы

- Публичный URL — HTTPS; хостинг завершает TLS и переводит HTTP в HTTPS
  **до** передачи в приложение. WebSocket снаружи — WSS.
- Бэкенд принимает только Unix sockets. Прямой запуск через обычный Node
  отказывается обслуживать TCP HTTP; `testHttp` не используется.
- Для Apache Passenger CJS entry отключает automatic listen hook и
  явно публикует только frontend. В LiteSpeed его собственный hook
  переводит frontend listen в Unix socket; adapter проверяет это.
  При передаче listener через fd 0 adapter сверяет inode fd с kernel
  `/proc/net/unix` и путём сокета хостинга. Если проверить нельзя — отказ,
  не доверие одному имени в env или переопределённому HTTP address().
  Проверка fd выполняется до публикации frontend и повторяется после bind,
  чтобы первый запрос при cold start не получал ложный transport_denied.
- Служебное управление — только loopback TCP с Bearer и запретом Origin,
  не входит в публичный proxy. Private listeners обходят hosting listen hook.
  Отдельная HTTPS-панель использует подтверждение Automesh и собственные
  короткие сессии; loopback Bearer в браузер не передаётся. См. [вход](NODE_PANEL.md).
- Пересыльщик входит в общий signal registry через отдельный Unix socket
  в каталоге 0700, socket 0600. Этот путь нельзя передать как Internet relay.
- `flock` запрещает одновременную запись нескольких процессов. Если хостинг
  запускает второй worker, он отказывается стартовать: это безопасно для
  данных, но может дать 503. Нужен один worker, либо будущая отдельная схема
  shared-worker, а не отключение блокировки.
- Shared-хостинг может остановить процесс при простое/лимитах. Очередь
  сохраняется, но доставлять её выключенный процесс не может. Нельзя
  обещать 24/7 без подтверждения хостинга. PassengerMinInstances и другие
  Passenger directives не переносимы автоматически на LiteSpeed.
- Master key — отдельный файл 0600 вне кода, web root и данных. Это НЕ
  изоляция от другого приложения того же Unix пользователя или root.
  VPS с отдельным service user и systemd credentials безопаснее.

## Развёртывание

Отдельный app root, например `/home/USER/automesh-node-app`; document root
поддомена не должен содержать исходники, зависимости или приватные данные.
Отдельный каталог `/home/USER/.automesh-node-private` (0700) с `master.key`
и `config.json` (0600), отдельный `/home/USER/.automesh-node-data` (0700).
Родительские каталоги должны принадлежать владельцу/root, не быть symlink
или доступны на запись группе/остальным.

Config (пути заменить, никаких plaintext tokens):

```json
{
  "version": 1,
  "transport": "tls-frontend-unix-v1",
  "publicUrl": "https://node.example.org",
  "dataDirectory": "/home/USER/.automesh-node-data",
  "masterKeyFile": "/home/USER/.automesh-node-private/master.key",
  "controlPort": 39304,
  "allowedOrigins": ["https://automesh.online"],
  "signalingEnabled": true,
  "maxBytes": 67108864,
  "maxMessages": 1000
}
```

1. До подключения приложения включить HTTPS redirect для всего поддомена,
   сохранить ACME validation, проверить сертификат. Не менять основной сайт.
2. Загрузить CJS entry, packages, ui, adapters/server и adapters/passenger,
   package.json/lock и лицензии. `npm ci --omit=dev --ignore-scripts`.
3. `node adapters/passenger/main.js keygen /PRIVATE/master.key`, затем
   `node adapters/passenger/main.js init /PRIVATE/config.json`.
   Повторная инициализация не заменяет ключ/идентичность/очереди.
4. Setup Node.js App: production, Node 24, startup `app.cjs`, отдельный
   app root/domain; env `AUTOMESH_NODE_CONFIG=/PRIVATE/config.json`.
5. Проверить HTTPS `/node/info`, отсутствие публичных `/status`, `/pair-code`,
   admin/секретов/кода; проверить WSS с подписанной тестовой регистрацией.
6. Проверить стабильность процесса без пользовательских запросов и параметры
   lifecycle у хостинга. Не считать успешный HTTP healthcheck проверкой 24/7.

## Управление по SSH

`node adapters/passenger/main.js status /PRIVATE/config.json`
показывает статистику без кода привязки. `invite` выдаёт одноразовый код
на десять минут; `qr-pair` / `qr-signal` пишут PNG в stdout.
`remove /PRIVATE/config.json ADDRESS --confirm-delete-node-data`
отзывает профиль и удаляет только его очереди. Текущие профили/seed в чате
не затрагиваются. Перед этим нужна осознанная резервная копия и подтверждение.

Резервировать отдельно private config/master key и весь data directory.
Никаких ключей в Git, document root, логах, screenshots или support tickets.

Основание hosting adapter:
[LiteSpeed Node.js Selector](https://docs.litespeedtech.com/lsws/cp/cpanel/cloudlinux/),
[Passenger explicit binding](https://www.phusionpassenger.com/docs/advanced_guides/in_depth/node/reverse_port_binding.html).
