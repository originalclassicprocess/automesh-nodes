# Home-node access: current boundary and next steps

Status: Windows 0.4.15 local preview. No new phone Bluetooth service, Internet
ingress, automatic discovery, or Linux desktop lifecycle is shipped here.

## What the assistant can actually prove

| Step | Observation | User action, only if required |
| --- | --- | --- |
| Preparation | Expected CA fingerprint, critical constraints, signer key, validity and PFX presence | Retry preparation; never silently replace a missing CA identity |
| Backend | Authenticated control status and HTTPS checked with this node's CA | Start or retry; explicit Stop stays stopped |
| This PC | Expected CA exists in CurrentUser/Root | Explicit Windows trust confirmation |
| PC app | Node reports authenticated membership, or initial app pairing completes | Copy a short-lived localhost invitation and open the configured Automesh site |
| Home network | Selected bound address belongs to a live Windows Private adapter | Connect to a trusted network; user changes its classification in Windows |
| Device access | Enabled Private / LocalSubnet / executable / port rule, plus manual-mode address/interface match | Explicit UAC action; no router or Public-profile changes |
| LAN TLS | Requests to all bound LAN addresses verify against this node's CA | Investigate failure; success is a PC-side check, not proof of phone connectivity |

The welcome offers PC / PC + phone. If the PC is already ready, only phone setup
or skip is offered. After a completed setup, healthy startup opens Overview.
The assistant skips completed actions; Overview retains its explicit open button.
It uses hidden, bounded observation workers and invalidates results when public
connection settings change. It never treats Windows certificate trust as a
substitute for account authorization or successful receipt of a message.

The present assistant is in Russian. English parity is still required before
calling the Windows home-node onboarding ready for an international public launch.

Browsers may separately require the website's local/loopback-network permission;
this is not the Windows firewall setting. Allow only the intended Automesh site
when its connection attempt requests permission. The PC assistant cannot grant
that browser permission, especially on another device. See [Chrome's current local
network access guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access).

## Bluetooth handoff: useful, but a separate feature

A nearby PC and phone can exchange connection data without Internet, provided
the phone app is already available offline and Bluetooth works on both devices.
The PC needs a small authenticated BLE GATT service/native bridge. The browser
Web Bluetooth role is a GATT client, not a general PC-to-phone advertising server:
see [Chrome's API and security requirements](https://developer.chrome.com/docs/capabilities/bluetooth).
This is separate from connecting to an existing Meshtastic peripheral.

Proposed first pairing: an explicit user gesture plus a QR or short verification
code binds stable node identity and public-key fingerprint. Only then accept
signed, encrypted address updates for that authorized phone. Updates need a
monotonic generation and expiry to reject rollback. A network change must not
grant a new account membership, send a seed, export a CA signing key or repeatedly
reuse a bearer pairing code. Keep QR/manual recovery available.

Periodic refresh should be opportunistic while the app is awake and connected.
Do not promise background BLE on every phone/browser or install certificate trust
through Bluetooth silently. [Apple requires explicit trust activation for manually
installed root profiles](https://support.apple.com/en-us/102390).

An authenticated same-LAN discovery/update mechanism is another candidate; compare
it with BLE before adding another mandatory step. Private IP changes and root
renewal on the PC are automated now; discovering the new IP from a disconnected
phone remains separate, unfinished work.

## Using the home node while away

The desired flow is sound: upload encrypted envelopes to an awake home PC, close
the phone, let the PC wait for the recipient. The existing outbound courier can
deliver already queued work. Uploading *new* work from another network requires
an externally reachable, authenticated path; a private LAN IP is insufficient.

Prefer a user-controlled private VPN or an authenticated outbound tunnel to a
chosen relay before public port forwarding. Keep the admin/control API loopback
only, bound upload quotas, normal account signatures, expiry and durable receipt
semantics. Never enable UPnP or expose the management token automatically. A VPN
marked Private by Windows may be selected by automatic mode; use manual binding
if that would permit an unwanted interface. Sleeping/offline PCs remain unavailable.

## Security assessment

It is not justified to claim that installing this node's root certificate is
equivalent in risk to an ordinary browser/game. Adding a trust anchor and an
inbound LAN service increases the security surface. Some VPN/security products do
similar things, but that comparison is not an audit or a security guarantee.

| Threat | Current protection | Remaining limit / follow-up |
| --- | --- | --- |
| LAN interception or node impersonation | HTTPS with exact hostname/IP validation; stable CA reference; messaging signatures | First root/pairing verification matters; never bypass TLS warnings |
| Misuse of the local CA | Non-exportable key in current-user Windows store; critical localhost/RFC1918 constraints, server-auth purpose, no subordinate CA | Malware running as the same user may use the key. Trust-anchor processing varies by platform; test each intended browser/OS. Constraints are defense in depth, not an app-private pinning substitute |
| Other LAN users probing the service | Private networks only; explicit LocalSubnet firewall rule; exact Origin/Host checks and authenticated queue operations | Origin/CORS checks are browser policy, not authentication. Authorized peers can still waste quotas/bandwidth; software vulnerabilities remain possible |
| Stolen PC / local user compromise | DPAPI protects configuration secrets; PFX is password-encrypted; queue content is end-to-end encrypted | An unlocked/compromised client may expose its accessible secrets and history. Node metadata and traffic timing are not hidden |
| Malicious update | Program manifest detects incomplete/corrupt payloads; pinned runtime checksum | Local preview remains unsigned. Hashes bundled alongside files do not authenticate a publisher; keep release provenance/update review separate |
| Lost availability | Graceful stop/restart, durable queue, bounded setup retries | No always-on guarantee if the PC sleeps; phone OS can suspend browsers; overnight tests remain necessary |

[RFC 5280 section 6.1.1](https://www.rfc-editor.org/rfc/rfc5280#section-6.1.1)
describes the trust anchor as an input to certificate-path validation; do not infer
universal enforcement of a root's extensions from one passing TLS implementation.
The isolated Node/OpenSSL fixture verifies an out-of-scope example.com certificate
is rejected, without adding the fixture root to an OS trust store. This is not an
iPhone/Android/Windows browser certification test.

Longer term, a native client that pins an individual node key can avoid installing
an OS-wide root. A private VPN is another deployment option. Both need explicit
design and testing; neither is silently introduced here. On permanent retirement,
remove the node's trust entry, its signing key, firewall rule and retained local
data deliberately; program uninstall alone preserves these for reinstall/recovery.

## Implementation order

1. Windows local preview and real overnight, lock/resume, DHCP, VPN and phone
   reconnect checks. Test multiple interfaces without changing queue identity.
2. Apply the same lifecycle invariants to the Linux personal node. Use its native
   service manager/key storage; do not port Windows DPAPI/registry code. Verify
   start/stop, restart, queue persistence, TLS renewal and network changes in a VM.
   VM tests do not replace real Wi-Fi/client-isolation/Bluetooth tests.
3. Design authenticated phone discovery/address updates, choose LAN and/or BLE
   based on platform support. Preserve offline pairing recovery.
4. Add opt-in remote upload separately, retaining the working delivery protocol.
5. Complete language/documentation parity and public-release preparation before
   presenting this as a mass-user home node.
