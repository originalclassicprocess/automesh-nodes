# Deploying your own hosting copy

The public repositories contain source and credential-free build/test workflows.
They do not contain the project's private production deployment jobs, SSH keys,
hostnames, hosting usernames, operational logs or backups.

For your own deployment, keep operational automation in a separate private
repository with narrowly scoped credentials and manually approved deployment.
Do not expose secrets to contributor/fork code. Follow [server setup](SERVER_NODE.md)
or [shared hosting](SHARED_HOSTING.md), using your own paths, origins and TLS.

The browser app, Windows Personal, Linux Personal and Server/cPanel packages
are distinct. Do not install the Windows/Linux desktop package into cPanel.
Do not run two instances against the same queue/key state. Back up private
configuration and encrypted state separately from code. Reinstalling code is
not permission to reset identities, queues or administrator ownership.

Сценарии обновления реального хостинга проекта и доступы к нему остаются в
приватных репозиториях. Открытие исходников не меняет серверы, DNS и сертификаты.
