# Серверная нода 0.4.5 preview

Для cPanel/LiteSpeed используйте отдельный [чистый shared-host запуск](CLEAN_START.md),
а не systemd-инструкцию ниже. Новый messenger origin — `https://automesh.online`.

Это Linux-служба для персональных подписанных ящиков, очереди исходящих и
необязательного сигналинга. Общие MAE/wire v1, адреса, подписи и лимит файла
20 MiB не меняются. Seed и ключи расшифрования сообщений остаются в клиенте.

## Что уже есть и чего пока нет

Есть HTTPS API, WSS `/signal`, отдельный loopback control, до восьми профилей,
изолированные очереди, TTL/квоты, сохранение файлов частями, перезапуск,
запросы с одноразовой подписью, отзыв профиля и QR. На сервере локальный
WSS-пересыльщик — **интернет-маршрут**, не LAN: `lanOnly` запрещён.
Внешний `courierRelay` необязателен; это дополнительный исходящий маршрут,
а не объединение сигналингов/цепочка нод.

Уже существующий `/mailbox/put` принимает только от самого получателя или
от разрешённого им отправителя, с подписью. На сервере этот API доступен
через HTTPS, но автоматического обнаружения интернет-ящика адресата,
node-to-node входящих, bridge домашняя→серверная и 3-hop **ещё нет**.
`internetIncoming: false` относится к отсутствию универсального межнодового
входящего маршрута, а не к запрету клиентского получения. Подписанные
`/inbox/list`, `/inbox/file/parts`, `/inbox/ack` выдают очередь получателю,
включая ситуацию без отправителя/WSS. Нужны членство и клиентские prekeys.

Клиент Automesh поддерживает серверные HTTPS URL, привязку по QR/приглашению
и явное согласие на вход администратора. Веб-панель использует отдельного
постоянного администратора, не назначает его автоматически из состава
профилей. Первый код выдаёт CLI `admin-setup`; далее вход подписывает только
назначенный профиль. Сессия панели — 15 минут, cookie Secure/HttpOnly/Strict,
изменения требуют Origin и CSRF. Шаблон Nginx включает inbox и public panel;
control-listener по-прежнему запрещён снаружи.

Готовый Linux-пакет и мастер настройки: [LINUX_NODE.md](LINUX_NODE.md).

## Требования

- Linux, локальный долговечный POSIX-диск (не NFS/общая папка/эфемерный диск).
- Node.js 22.12+, рекомендуется 24; `/usr/bin/flock` (util-linux).
- Один процесс на директорию данных. Несколько workers/cluster запрещены.
- Для шаблона службы: systemd 250+ с `LoadCredentialEncrypted` и `systemd-creds`.
- Домен, действующий TLS-сертификат с SAN домена, Nginx или прямой HTTPS.
- Отдельный непривилегированный пользователь, права на свой data directory.

Общий SSD-тариф сам по себе не обеспечивает эти условия. На shared/cPanel
хостинге сначала подтверждаются постоянный Node.js-процесс, WSS, один worker,
долговечный диск и способ доставки credentials. Не заменять отсутствующий
credential plaintext-ключом в data directory. Предпочтительный режим — VPS.

## Данные, ключи и управление

`dataDirectory` (0700, владелец service user): `server-admin.json` с зашифрованным
Bearer-token; `courier-key.json` с зашифрованным отдельным ключом ноды;
`state.json` (адреса/разрешения, не seed); непрозрачные входящие, исходящие,
части файлов и квитанции; `.writer.lock`. Рабочие файлы создаются 0600.

Master-key: 32 случайных байта **вне dataDirectory**, лучше encrypted systemd
credential. AES-256-GCM использует случайный nonce и привязку к назначению.
Копия только очередей/конфигурации без этого ключа не открывает ключ ноды и
admin-token. Копия всего сервера с root/systemd host-key может их открыть.
Root, процесс того же service user или взлом работающей ноды не защищены этой
схемой. Пароль/seed пользователя не нужен, но это не эквивалент аппаратного HSM.

TLS private-key также доставляется отдельным credential; не кладётся в Git,
конфигурацию, очередь, параметры команд или логи. Секретные файлы требуют
0600/0400, нормального владельца, без symlink/hardlink и небезопасных родителей.
Настройка/сертификат могут быть 0644, но не writable другими пользователями.
`CREDENTIALS_DIRECTORY` содержит **путь**, не значение ключа. При его наличии
используются `master-key`, `tls-key`, `tls-cert`; fallback при ошибке запрещён.

Control всегда HTTP **127.0.0.1:3004**, отдельный токен, без browser Origin.
Его нельзя публиковать через proxy/port forwarding. CLI получает токен из
зашифрованного файла и не печатает его; `status` также скрывает pair-code.
`invite`/QR показываются только по явной команде администратора (10 минут).

## Развёртывание оператором (не выполнено автоматически)

Шаблоны: `adapters/server/config.example.json`, `automesh-node.service`,
`nginx.example.conf`. Замените `node.example.com` реальным доменом везде.
Исходники и зависимости устанавливаются в `/opt/automesh-nodes` read-only
для service user; `npm ci --omit=dev --ignore-scripts`. Node binary путь
в unit должен соответствовать реальному установленному runtime.

Нужны `/etc/automesh-node` (root, 0755), приватная подготовительная директория
`/etc/automesh-node/private` (root, 0700), config root-owned 0644 и отдельный
пользователь/группа `automesh-node`. Сертификат с полной цепочкой размещается
в `/etc/automesh-node/tls-cert.pem`; копии TLS private key не должны попасть
в dataDirectory. Симлинки Certbot следует читать оператору при обновлении,
а ноде подавать отдельные credentials/обычные файлы.

Создание нового master-key, **только однажды**, от root:

```sh
node /opt/automesh-nodes/adapters/server/main.js keygen /etc/automesh-node/private/master.key
systemd-creds encrypt --name=master-key /etc/automesh-node/private/master.key /etc/credstore.encrypted/automesh-master.cred
systemd-creds encrypt --name=tls-key /etc/automesh-node/private/tls-key.pem /etc/credstore.encrypted/automesh-tls.cred
```

Предварительно создайте `/etc/credstore.encrypted` root-owned 0700.
Нужен безопасный отдельный backup master-key: encrypted credential часто
привязан к host/TPM. Не удалять единственную восстановимую копию и не
пересоздавать ключ после ошибки расшифрования. Генератор не перезаписывает
существующий файл; штатный `start` не создаёт новый master/admin-token.

Одноразовая инициализация private data directory и encrypted admin-token:

```sh
sudo systemd-run --wait --pipe --unit=automesh-init --uid=automesh-node --gid=automesh-node \
  -p StateDirectory=automesh-node -p StateDirectoryMode=0700 -p UMask=0077 \
  -p LoadCredentialEncrypted=master-key:/etc/credstore.encrypted/automesh-master.cred \
  node /opt/automesh-nodes/adapters/server/main.js init /etc/automesh-node/server-config.json
```

Инициализация не перезаписывает существующий admin-token и отказывается от
непустых orphaned данных. Установите unit, выполните `systemd-analyze verify`,
`systemctl daemon-reload`, затем включите службу. Шаблон по умолчанию слушает
HTTPS 127.0.0.1:3003 за Nginx. Public bind `0.0.0.0` только явно для прямого
HTTPS на непривилегированном порту, закрытый admin остаётся loopback.

Nginx-шаблон публикует **только** allowlisted public API и `/signal`, проверяет
сертификат upstream, передаёт правильный Host, ограничивает подключения/тело
и rate по IP. Не выключать `proxy_ssl_verify`, не проксировать control-port.
Node не доверяет X-Forwarded-* и не использует их для авторизации. Сертификат
publicUrl и TLS SNI проверяются даже при собственном WSS по loopback.
Нужны firewall (извне только 443), `nginx -t`, ACME-обновление сертификатов
с обновлением TLS credential и перезапуском. Подтверждение сохранения/очереди
не является подтверждением доставки получателю.

## Управление

Запускайте CLI от service user в credential-контексте. Например для статуса
через кратковременный systemd job (без вывода master/token):

```sh
sudo systemd-run --wait --pipe --uid=automesh-node --gid=automesh-node \
  -p LoadCredentialEncrypted=master-key:/etc/credstore.encrypted/automesh-master.cred \
  node /opt/automesh-nodes/adapters/server/main.js status /etc/automesh-node/server-config.json
```

В этом же вызове заменяйте `status` на `invite`, `qr-pair` или `qr-signal`.
QR команды выводят PNG в stdout; не отправляйте вывод в публичный журнал.
Профиль удаляется только явным действием:

```sh
node adapters/server/main.js remove /etc/automesh-node/server-config.json mesh1... --confirm-delete-node-data
```

Сначала отзывается доступ, затем удаляются только его очереди/файлы;
восстановление cleanup до открытия портов, слот освобождается. Уже полученные
копии и клиентские чаты остаются. Web-панель/новый Connect UI здесь не включены.

## Перезапуски, backup и границы проверок

SIGTERM дожидается текущих операций, closes sockets и releases flock. SIGKILL
освобождает kernel lock; committed записи восстанавливаются по существующему
атомарному протоколу, uncommitted temporary files не подтверждаются. Без
гарантий fsync/rename диска и при потере питания абсолютного обещания нет.
Не удалять `.writer.lock` при работающем процессе: это может создать второй inode.

Backup делается при остановленной службе: **вся** dataDirectory и отдельно
master-key/config, с ограниченными правами и шифрованием носителя. TLS ключ
восстанавливается/перевыпускается отдельно. Проверяйте restore в другой VM,
но не запускайте две копии одной courier identity в интернете одновременно.
Quota приложения не заменяет disk quota ОС: нужен запас места и мониторинг.

Автотесты: отказ plaintext/неверного key, permissions/symlink/hardlink,
конкурирующий writer с разными портами, HTTPS/Origin/Host/admin/replay,
привязка/QR, две независимые очереди, отзыв, файл после рестарта, WSS доставка
с проверенной квитанцией, реальные SIGTERM/SIGKILL, отказ bind. На Windows
Linux-only tests явно skipped, а не выданы за успешные. GitHub Linux runner
проверяет эти сценарии и синтаксис systemd unit. Он не является проверкой
вашего тарифа/production Nginx, сервис не устанавливается на ваш компьютер.

Ссылки на первичные контракты: [systemd credentials](https://github.com/systemd/systemd/blob/main/docs/CREDENTIALS.md),
[systemd.exec](https://github.com/systemd/systemd/blob/main/man/systemd.exec.xml),
[Node.js filesystem](https://nodejs.org/docs/latest-v24.x/api/fs.html).
