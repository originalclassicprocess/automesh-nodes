# Node security policy

[Русский](SECURITY.ru.md). Experimental preview; no independent cryptographic
security audit, anonymity guarantee or support lifetime is claimed.

## Reporting

Use GitHub **Security → Report a vulnerability** for a private report. Otherwise open an issue requesting a private contact, without
vulnerability details or secrets. Do not post seeds, passwords, node keys,
private invitations, configuration, real chat exports or identifying addresses.
Use disposable profiles and include the version, adapter and redacted steps.

## Boundaries

- Profile seeds/private keys, receive prekeys and file keys remain in clients.
  Nodes store encrypted envelopes/parts but observe addresses, sizes and timing.
- The runtime requires an explicit SecretProtector. Windows uses DPAPI
  CurrentUser. Linux/server uses AES-256-GCM with an external OS credential.
  A test protector is not a production configuration.
- DPAPI does not protect against malicious processes running as the same user
  or an administrator. Linux root or a compromised running process can also
  access secrets. Same-user shared hosting is not process isolation.
- Windows HTTPS/WSS binds loopback and up to 16 explicitly selected private
  IPv4 addresses. Control remains a separate loopback-only authenticated port;
  never forward or reverse-proxy that control port. No public wildcard bind.
- Windows CA trust is an explicit user action. The signing key stays in the
  user's Windows key store; only the public CA certificate goes to phones.
  Local address changes renew a leaf, not the identity or queue. Do not bypass
  browser TLS warnings, disable certificate checks or trust someone else's CA.
- Linux/server HTTPS defaults to loopback behind a validating TLS proxy; public
  binding requires explicit configuration. Master/TLS keys remain outside
  queue data. Linux uses a kernel single-writer lock and supports OS credentials.
- Signed requests bind method, path, body, node ID and a short-lived challenge.
  Address/key binding, profile membership and sender authorization are separate
  checks. Signaling access is not mailbox access or administrator authority.
- File size, queue bytes, profiles, sender slots and retention are bounded.
  File retrieval requires recipient authorization. LAN-only permissions are not
  expanded by choosing an Internet route.
- Acknowledged storage follows atomic commit. Windows lacks directory fsync;
  power loss and disk failure remain limits. Invalid acknowledged data is not
  silently reset. A receipt is not proof that a human read a message.
- Profile removal persists revocation before cleaning its queues. It does not
  delete client history/backups or revoke the seed globally. Logical deletion
  is not secure erasure of an SSD and cannot recall delivered copies.
- Public arbitrary-node discovery/automatic bridging is not promised. The
  receiver must open/unlock its app; infrastructure does not provide browser
  background execution. Do not infer durable radio storage from a radio ACK.
- Windows installer payloads are checked for names, duplicates, size and hash
  before installation. Hashes do not establish independent publisher identity;
  the preview installer is not Authenticode-signed.

Before production-like deployment, verify administrator access, exact origins,
TLS/proxy/firewall behavior, persistent disk, updates and restoration of an
**encrypted** state backup on that actual host. Store code rollback and state
backups separately; never publish either host credentials or state backups.
