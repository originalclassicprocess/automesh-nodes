# Windows home-node recovery — 0.4.16 local preview

The priority is a usable home node before a project website or public launch.
Windows-specific lifecycle changes do not claim Linux/server lifecycle parity.

## Normal operation

- A saved origin from a previous deployment does not authorize the new app site.
  The welcome flow offers an explicit approval of the packaged application origin,
  retaining other approved sites, secrets and queues. It never permits every site.
- Routine background preparation no longer hides a valid phone invitation. Readiness
  observations use a 60-second interval once HTTPS is ready (15 seconds otherwise).
  QR shows its remaining lifetime (up to 10 minutes); expiry, changed connection
  settings or a new backend invitation invalidates it. Refresh is explicit.
- Allow WebKit's cache-related CORS request headers while retaining exact-origin
  authorization, Host validation, trusted TLS and signed requests.
- 0.4.15 repairs the field failure where a single adapter became a scalar string
  and preferred-address indexing saved only `1`. Correct an already truncated
  preferred address even if the interface list/leaf are unchanged; that repair
  does not regenerate TLS or change message identity or queue contents.
- Loopback (`localhost` / `127.0.0.1`) and a private LAN address serve different
  clients: this PC versus other home devices. Neither is a signaling-server list.
  Multiple outgoing signaling servers are a separate planned requirement; this
  patch retains the existing configured courier relay.
- First run opens a full-window welcome with PC / PC + phone choices. Until PC
  readiness, tabs/footer and setup-skip actions are hidden. A ready, previously
  configured PC offers phone setup or skip; a completed setup reopens directly
  into Overview when still healthy. Background Windows-sign-in start remains.
- The flow checks preparation even before the backend responds, then runtime,
  Windows browser trust and app pairing. Existing authenticated memberships skip
  re-pairing. The optional phone path checks Private network, firewall and LAN TLS,
  then walks public-certificate export and an inline pairing QR. Phone certificate
  installation and final connection are explicit user confirmations, not inferred
  from a local PC test. Expired pairing QR images are removed.
- Completed items are green; one remaining action is shown. There is no universal
  skip before PC readiness. A prepared certificate does not imply a running node;
  a backend failure is not mislabelled as certificate preparation. Port errors
  permit in-place port adjustment. Missing CA keys allow explicit replacement
  with a disclosure that trust must be installed again; queue/identity stay intact.
- Overview: Start, Stop, connect this PC, connect another device, queue status.
- Network: automatic Windows Private adapters by default, or explicit manual
  binding; preferred address for LAN QR. One identity, queue and signaling
  registry across loopback and up to 16 selected private IPv4 addresses.
- Maintenance runs outside the GUI thread every 30 seconds while running.
  Address changes and impending leaf-certificate expiry trigger reconfiguration.
- Stop is an explicit intent. A late maintenance result must never override it.
  Queue writes finish before backend replacement; there is no forced three-second
  production kill. An authenticated orphaned backend is stopped before replacement.
- Saving a new control port waits for the old backend to stop, preventing a race
  between reading configuration and sending shutdown to the previous port.
- Windows-sign-in startup is separate from opening the launcher, which starts
  a configured node. Reopening its shortcut activates the existing tray window.

## TLS and network boundary

The former implementation deleted its CA key and required trust replacement on
every DHCP change. The preview keeps a non-exportable CA key in CurrentUser/My,
with a five-year certificate, critical RFC1918/loopback/localhost name constraints,
server-auth usage and no subordinate CA. Leaf certificates cover all selected
IPs and localhost, last at most six months, and renew within fourteen days of
expiry. A missing/mismatched CA reference fails instead of silently changing trust.
The root approaching expiry requires attention; it is not silently replaced.

No trust is installed automatically. The first migration from a legacy node
requires trusting its new root once. Export only the public .cer to phones.
The CA signing key belongs to the Windows user and is not a messaging identity;
do not distribute it. Removing the program keeps data and this key for reinstall;
remove node trust/key through Windows when permanently retiring the node.

The certificate extension syntax follows [Microsoft's PKI documentation](https://learn.microsoft.com/en-us/powershell/module/pki/new-selfsignedcertificate).
DPAPI config protection, exact Origin/Host checks and account signatures remain.
No wildcard/public listener, TLS bypass, router forwarding or port scanning.
Automatic firewall permission is explicitly enabled by the user, scoped to
Private + LocalSubnet + exact executable + port; manual rules keep exact address
and interface. Private VPN adapters are eligible if Windows marks them Private;
operators can choose manual binding where that classification is unsuitable.

## Remaining work before calling this a mass-user node

1. Real overnight/lock/resume test on an ordinary Windows PC, including Wi-Fi
   changes, VPN use and phone reconnects. A sleeping/off computer is unavailable.
2. Stable discovery for a phone that only knows yesterday's DHCP address. The
   stable localhost URL solves the same-PC case, not remote discovery. Assess
   authenticated service discovery/stable hostname separately, retaining node-ID
   pinning and explicit private-network permission. Do not scan subnets silently.
3. Field-check the new welcome flow, finish translation parity and review
   packaging/update behavior on clean Windows.
4. Apply the lifecycle approach to the Linux personal node with its own service
   manager and TLS setup; the Windows key-store implementation is not portable.

Automated fixtures cover multiple Private adapters, DHCP changes, loopback-only
operation, unchanged-network no-op, persistent CA/leaf renewal, preserved quotas,
explicit Stop versus late maintenance, TLS and existing queue behavior. They do
not constitute an overnight or physical-phone test.

See [the local-access security and follow-up design](HOME_NODE_CONNECTION_DESIGN.md)
for the trust boundary, Bluetooth handoff and access from outside the home. These
future connection paths are not implemented by this Windows preview.

## iPad / VPN connection diagnosis

Opening `/node/info` in a tab and reading it from an Automesh page are different
checks: a tab may succeed while the app is denied by the node's approved-origin
list. An observed `origin_denied` for the actual app origin is a confirmed blocker;
approve that exact HTTPS origin in setup. Never use a wildcard or disable CORS.
WebKit can send cache headers on no-store fetches; approved preflights include
Cache-Control and Pragma without weakening proof validation.

A browser local-network prompt is not universal, so its absence alone is not a
failure. Browser permission, certificate trust, CORS and OS/VPN routing are
separate boundaries. The PC's self-check cannot prove reachability from an iPad.

`localhost` always names the device running the browser: on iPad it is the iPad,
not the PC. Use the PC's current LAN IP in the phone invitation. If either VPN
blocks LAN, use that VPN's supported Allow LAN / local-subnet exclusion option
on the affected device; connecting both devices to a commercial VPN does not
create a shared LAN. Automesh cannot override a VPN firewall/kill switch, and
this patch does not change VPN routes, browser privacy settings or firewall rules.

Sources: Apple TN3179 (local network privacy), WebKit bug 233916 (cache preflight),
and Proton VPN's Allow LAN connections documentation. Real iPad and per-provider
VPN combinations remain field checks, not an automated-test claim.
