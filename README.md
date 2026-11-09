# Automesh Nodes

[Русский](README.ru.md) · [Project history](HISTORY.md)

Optional personal messaging infrastructure for
[Automesh](https://github.com/originalclassicprocess/Automesh): shared protocol,
encrypted queues, Windows home launcher, Linux and server/cPanel adapters.
Experimental public source preview; no independent security/cryptography audit.

**Public packages:** [0.4.17 — Windows, Linux and separate server/cPanel archive](https://github.com/originalclassicprocess/automesh-nodes/releases/tag/v0.4.17).
Built from a clean public commit by `release.yml`, with GitHub attestations for
each binary/archive. This packaging release retains the existing runtime and
platform setup behavior; publishing it does not update a running server.

## Editions

| Edition | Interface / status |
| --- | --- |
| Windows x64 | 0.4.17; PC / PC + phone welcome and guided setup/recovery |
| Linux Personal x64/glibc | 0.4.17; existing terminal HTTPS setup, CLI/service and web panel; Windows wizard not ported |
| Server / cPanel | Separate server/Passenger adapters, operator-managed TLS/configuration; not a desktop installer |
| macOS | Shared-core CI only; no packaged node, installer or wizard |

This clean repository does not import old private release assets or CI logs.
The previous distribution baselines were Windows 0.4.16 and Linux/server 0.4.12.
Preview Actions artifacts remain candidates; published packages are under Releases.
[Platform readiness](docs/PLATFORM_STATUS.md) · [Edition details](docs/NODE_EDITIONS.md).

## Purpose and behavior

Decentralization, storage on people's own devices, and private communication
encrypted by default, while keeping setup understandable. A home PC should be
useful without renting a VPS. There is no completed global autonomous mesh.

- Authorized per-profile encrypted text/file queues, signed requests and
  receipts, TTL, sender cancellation, quotas and restart recovery.
- Optional signaling/courier; separate device text inboxes and owner-signed
  device permissions. No seed transfer to the node.
- Windows current-user DPAPI; Linux/server encrypted secrets with an external
  OS credential. Same-user/root compromise remains a threat.
- Explicit certificate/network permissions and private-interface boundaries.
  The computer must remain awake. Radio ACK/node storage is not human reading.
- Separate server/cPanel adapter; same-user shared hosting is not isolation.

## Develop and build

Use Node.js 24 (minimum 22.12) and synthetic state; no hosting secrets needed.

```sh
npm ci --ignore-scripts
npm test
```

Linux: `node scripts/check-server-unit.mjs`.
On the matching platform: `npm run build:windows` / `npm run build:linux`.
Builders verify pinned official Node.js runtime hashes and include notices.
Outputs are under `downloads/`; building does not install/start a node,
import certificates or open firewall rules. Windows is not Authenticode-signed.
Public releases use `.github/workflows/release.yml`; verify the actual
artifact and that workflow identity, not just a checksum or preview build. No prior private artifact
is retroactively attested by this publication.

[Windows](docs/WINDOWS_NODE.md) · [Linux](docs/LINUX_NODE.md) ·
[Server](docs/SERVER_NODE.md) · [Shared hosting](docs/SHARED_HOSTING.md) ·
[Architecture/wire contract](docs/CONTRACT.md) · [Contribute](CONTRIBUTING.md) ·
[Security](SECURITY.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)

## Help and limits

Independent security review, clean Linux VM installation, sustained Windows
uptime/reconnect, accessibility and localization need help. The new Windows
wizard is not fully translated. Network/browser suspension, TLS, hosting quotas
and disk failure remain limits; no anonymity or guaranteed delivery is claimed.
Do not run multiple instances against the same real node state. Back up state
and keys separately from code. No production deployment workflows or hosting
credentials are included in this public repository.

Project code: [MIT](LICENSE). Dependencies retain their own licenses.
