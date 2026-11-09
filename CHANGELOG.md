# 0.4.17 — Public release provenance (2026-11-09)

Versioned, attested Windows/Linux/Server builds in the public repository. No transport/runtime changes.

## 0.4.16 — Windows Personal release (2026-11-07)

- Detect an unapproved current application origin after changing deployments; offer explicit approval without discarding other approved sites, secrets or queues.
- Accept WebKit cache-related CORS headers for approved sites, retaining exact origin checks and signed authorization.
- Keep a validated QR visible during background preparation, show its remaining ten-minute lifetime and invalidate changed/expired invitations. Reduce readiness observations after HTTPS is healthy.
- Cover browser preflights, outdated-origin setup and QR stability in isolated tests; real iPad/VPN behavior still requires device verification.

## 0.4.15 — single-adapter startup repair (unreleased)

- Keep automatic address selection as an array even when only one LAN adapter is available. Previously the preferred address could become the first character of the IP, preventing startup.
- Repair an already truncated preferred address even when the address list and certificate are unchanged. Preserve the TLS certificate, queue, identity and quotas for this repair.
- Report an invalid preferred address separately. Cover a single adapter, single-adapter DHCP changes and recovery by the actual packaged preparation worker before startup.
- Multiple signaling connections are a separate requirement; this release repairs startup without adding signaling routes.

## 0.4.14 — guided Windows welcome (unreleased)

- Replace the diagnostic setup panel with a full-window welcome: PC / PC + phone. A ready PC offers phone setup or skip; PC setup cannot be dismissed into the dashboard before readiness.
- Walk one action at a time through preparation, runtime, PC trust and app pairing, then optional home-network permission, phone certificate and inline pairing QR. Retain one path map and keep completed steps green.
- Check preparation even while the backend is stopped. Distinguish preparation failures from backend failures; expose safe startup reasons, port adjustment and explicit certificate recovery without deleting queues.
- Exercise the actual packaged background worker with an unstarted node, as well as welcome gating and existing TLS/queue/restart behavior. No deployment or real-phone verification is claimed.

## 0.4.13 — Windows home-node recovery (unreleased)

- Add a startup assistant with PC / other home devices / both modes, a readiness map, remaining-step count and one required action at a time. Ready installations stay quiet; observation workers do not install trust or change firewall settings.
- Validate the expected constrained local CA before offering Windows trust. Check TLS and firewall readiness in the background and discard observations for superseded network settings.
- Start from the overview; remember automatic Windows Private-network selection, keep one queue across multiple private interfaces, and stay available through localhost without a home network.
- Prepare DHCP/TLS changes outside the UI thread and gracefully restart the backend without replacing its messaging identity, profile bindings or quotas.
- Keep a non-exportable, current-user CA signing key for renewal. Restrict issued names to localhost, loopback and RFC1918 addresses and server authentication. Legacy nodes need one trust migration; trust installation remains explicit.
- Scoped automatic Private/LocalSubnet firewall permission survives DHCP. No Public-profile or router access is enabled.
- Poll status and shutdown asynchronously; explicit Stop wins over late maintenance completion. Reopening the launcher shows the existing tray window. Add a local-only pairing QR and copy action.
- Automated network, TLS-renewal and queue checks cover the changes. Overnight operation and real phone/network transitions still need a field check. No automatic peer discovery or Linux lifecycle changes are claimed.

## 0.4.11 — explicitly authorized recipient HTTPS delivery (2026-10-27)

## 0.4.12 — authenticated message quota reporting (2026-10-27)

- Add optional message-capacity fields to the authenticated outbox status snapshot, including originating-profile count and the actual enforcement limits.
- Reuse the existing profile count/byte limits in enforcement and reporting; no quota, expiration, encryption, transport or authorization changes.
- Quota tests cover profile isolation, configured global limits, retained receipts and restart.

- Add three narrowly scoped `/receive/*` endpoints. Both recipient authentication and a sender-signed, node-bound, expiring grant are required. Each grant only covers that member sender's envelopes for that recipient; no membership or outgoing rights are granted. Existing `/inbox/*` membership checks remain intact.
- Recipient list/parts/receipt operations retain normal signature verification and durable receipt-before-deletion behavior, including files. App 0.4.6 learns the source through signed contact exchange and can receive while the sender is closed.
- Expose aggregate discovered-route readiness for diagnostics. Routing, quotas, private data, node identity and signaling session ownership are unchanged.

## 0.4.10 — authoritative queue quota and owner inventory (2026-10-27)

- Authenticated profile status includes separate profile/node file capacities and total reserved node storage, without changing configured limits.
- Add bounded owner-only /outbox/list for existing signed jobs and staged uploads. No consumption or general admin purge; other profiles remain inaccessible.
- App 0.4.5 repairs leftover copies only after verified direct receipt, using the existing signed author cancellation. Node data format and delivery routing are unchanged.

### 0.4.6 — configurable and visible queue limits (2026-10-26)

## 0.4.9 — read-only peer prekey availability (2026-10-26)

- Add authenticated /prekeys/availability for a correspondent to inspect only their own owner-signed published stock. Inspecting never allocates a key; unrelated callers cannot inspect another correspondent’s inventory.
- App 0.4.4 uses the count asynchronously, separately from delivery and direct chat readiness. Unknown/unreachable stock is not shown as zero.
- No changes to ciphertext, TTL, one-use allocation, queue cancellation or routing. Node private-data format is unchanged.

## 0.4.8 — sender-controlled queue lifecycle (2026-10-26)

- Sender-authenticated cancellation for courier messages and files; no general administrative purge endpoint.
- Durable canceled/expired records retain owner-only outcomes and replay protection for 30 days without ciphertext or file bytes. Explicit retries use new message identifiers and keys.
- File cleanup recovers after interruption, receipt verification precedes cancellation results, and expiry follows the node clock. Existing routing remains unchanged. See docs/QUEUE_LIFECYCLE.md.

## 0.4.7 — public prekey directory (2026-10-26)

- Add authenticated publication and one-use allocation of owner-signed public keys, isolated by owner and sender. Private keys stay on clients.
- Preserve immutable reservations over lost replies, restart, rotation and stale owner backups; fail closed on ambiguous persistence errors.
- Separate publication and delivery lifetimes. Existing courier transport, files, receipts and node routing are unchanged. See docs/COURIER_PREKEYS.md.

- Default to 128 pending files per node and 16 per originating profile, configurable without changing wire format; lowering count quotas preserves stored files.
- Reclaim partial uploads after one hour without new chunks, preserving progress over restarts. Complete files retain signed delivery expiry/receipts. Quota rejection of an envelope leaves its upload resumable.
- Reserve up to 8 MiB for ordinary messages when accepting new files. Distinguish file, sender, envelope and storage limits in optional backward-compatible errors and panel counters.
- See docs/QUEUE_LIMITS.md, including the rollback restriction when old 0.4.5 code encounters more than 16 files. No general purge API, key lifetime or crypto change.

 Changelog

## 0.4.5 — signed courier route discovery (2026-10-25)

- Add a bounded inter-node signaling bridge for ordinary primary text. Recipient-signed advertisements supply public WSS routes; no deployment domains are installed as universal fallbacks.
- Keep ciphertext, source queues and recipient-signed receipts unchanged. Persist authenticated route updates separately, reject rollback and retain known route timestamps through expiry/restart.
- Limit discovery to 12 sockets, verify TLS/DNS answers, deny private/mapped/reserved addresses and redirects. Existing LAN, files, membership and device routes remain separate.

## 0.4.4 — clean deployment preparation (not published)

- Shared public deployment defaults: app `.online`, node `.space`; project information website disabled until an owned domain is selected.
- Linux/shared-host setup retains explicit app-origin overrides; Windows uses the same defaults with an editable allowed HTTPS app origin. Existing configurations/keys are not rewritten.
- Shared-host packages include checksums and installation instructions, no generated keys/state. No hosting or DNS changes; no independently signed release.

## 0.4.3 — private independent-device text preview

Optional owner-signed device directory v2, nonce-bound signed checkpoints,
independent physical inboxes/prekeys, immutable HPKE envelopes and per-device
durable receipts. Existing v1 validators/profiles are unchanged; directory
activation requires a paired owner to publish a signed opt-in. Linked devices
do not consume extra profile slots or receive node administrator rights.
Only the physical owner can publish/renew/revoke device authorization. Message
devices can authorize/revoke logical contact senders, not add devices.

Version/revocation rollback checks, one-use key reservations, disk restart,
recipient isolation, aggregate quota accounting and owner-removal cleanup are
covered by tests. Expired public control metadata is recoverable only by the
original physical owner; expired devices still cannot read queues.
Lists expire within 30 days; prekeys/envelopes within seven days. Node freshness
is trust in the selected node's latest accepted state, not global consensus.
Device labels/lists are public metadata, not secret content.

Companion app: 0.3.1 text-only test workspace. No history/file/call synchronization,
root removal/delegation, TURN, native push or independent cryptographic audit.
Existing TLS, private node keys, bindings and administrator stay unchanged.

## 0.4.2 — private preview

Hardened authorization/proofs and session/inbox handling; bounded Windows
atomic-rename retry; separate Windows/Linux packages with pinned runtime and
payload integrity. Linux setup preserves separate keys/data and refuses overwrite.
English-default admin web panel and Linux setup with Russian choice, configurable
app HTTPS origin for migration, documented real features and limitations.

Not completed: full Windows/client localization, public artifact attestations,
Authenticode, TURN, automatic global mesh, clean VM service acceptance.
Repositories remain private, history preserved. GitHub downloads require access;
the test app keeps site-hosted download buttons without embedding owner tokens.

Linux source acceptance: 61 tests, 59 passed, 2 Windows-specific skipped in an
isolated test directory beside production. Not a systemd/clean VM installation.
Windows source tests skip POSIX-only checks. Packaging checks are separate.
