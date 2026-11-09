# Contributing to Automesh Nodes

Use Node.js 24 on a disposable development copy. No production config, master
key, certificates or queues are needed for tests.

```sh
npm ci --ignore-scripts
npm test
```

On Linux also run `node scripts/check-server-unit.mjs`. Build the Windows
installer on Windows with `npm run build:windows`, or the Linux package with
`npm run build:linux`. Building a package does not install or start a node.
Do not run installers or setup scripts against your real node during a review.

`packages/protocol` defines wire contracts; `packages/runtime` implements shared
services; `adapters/windows`, `adapters/linux`, `adapters/server` and
`adapters/passenger` integrate their host platforms; `ui` contains the node panel.
The app repository contains a synchronized compatibility snapshot, not a second
canonical runtime. Submit node changes to AutomeshNodes.

Keep reviews small. Explain the user-visible change, actual validation and
platform skips. Discuss protocol, authorization, persistence, TLS and migration
changes first. Preserve existing identities and acknowledged queues. Keep a
rollback/data-recovery plan where relevant. A radio/network ACK is not a read
receipt; UI must not invent stronger delivery guarantees.

Contribute code/assets you can license under MIT, retaining dependency notices.
Use synthetic accounts and fixtures; never attach real user exports, config,
keys, pairing QR codes or private addresses. Follow [SECURITY](SECURITY.md) for
vulnerabilities. Independent security review, Linux clean-install tests,
Windows recovery, internationalization and accessible UX are welcome.
