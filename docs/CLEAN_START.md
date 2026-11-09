# Clean shared-host launch · node 0.4.5

Default roles: messenger `https://automesh.online`, new node
`https://automesh.space`. The project information website is disabled; no domain
has been selected for it and none is required to run the messenger. Defaults live in
`packages/deployment/src/defaults.js`; explicit app origins remain configurable.
Only the messenger is allowed by the fresh node configuration, not the project
information site. Existing configurations/keys are never silently reset.

This package is for cPanel Passenger/LiteSpeed, not systemd/VPS. It contains
program files and production dependencies only: no credentials, keys, account
data, queues or certificates. It was prepared locally, not deployed or signed.

Use a new app root `/home/USER/automesh-node-app` and separate document root
`/home/USER/automesh.space`. Enable valid public HTTPS before starting the node.
In the cPanel Node environment, replace USER and run once on a clean account:

```sh
node scripts/verify-shared-package.mjs
node scripts/setup-shared-host.mjs /home/USER https://automesh.space /home/USER/automesh.space 39304 https://automesh.online
```

The setup creates private keys/configuration outside all web roots. Do not
re-run over partially initialized state or copy secrets into the app root.
Configure Setup Node.js App: production, one worker, startup `app.cjs`, URL
`https://automesh.space`, environment variable
`AUTOMESH_NODE_CONFIG=/home/USER/.automesh-node-private/config.json`.
Start through cPanel, then check:

```sh
node scripts/check-shared-host.mjs https://automesh.space https://automesh.online
node adapters/passenger/main.js admin-setup /home/USER/.automesh-node-private/config.json
```

The admin-setup command prints a secret one-time code. Keep it private. Sign in
to the node panel and approve with a fresh Automesh account on `.online`.
Keep control port loopback-only. Confirm WSS, idle/restart behavior and quotas;
shared hosting does not guarantee uninterrupted background delivery. A backup
must include both the private master key/config and the complete data directory.

If `.space` previously hosted the messenger, an old service worker can show its
cached UI. Use a clean browser profile or explicitly unregister that worker;
this package never deletes browser databases. No migration of test accounts is
performed. See also [SHARED_HOSTING.md](SHARED_HOSTING.md).
