# Automesh Nodes 0.4.19

Server nodes can optionally retain a client-signed, content-free Web Push wake
request alongside an accepted courier submission. The original encrypted courier
job, node authentication, durable storage acknowledgement and receipts are unchanged.
Older clients and nodes keep their existing delivery paths. Installed personal
nodes do not need this update for browser notifications sent by the application.

The wake relay is enabled only for Internet/server role. It advertises its capability
and operator-approved HTTPS application providers, forwards no arbitrary URL, and
cannot send reverse reminders. The provider independently verifies the original
account signature and receiving-device contact permissions. Node code has no VAPID
key or browser push endpoint. A failed wake never rejects a stored message.

The private wake queue is bounded to 256 small records, survives restart, and
expires work within 90 seconds (the provider's signed-request freshness window).
HTTPS operations have an overall eight-second deadline, no redirects, and bounded
attempts. Corrupt optional wake storage disables this feature without disabling
the node. Internet-disabled/LAN-only messages do not create external wake traffic.

Validated with signature/recipient/provider isolation, restart/retry, membership
revocation, optional-storage failure and existing courier/node regression tests.
Actual browser/OS notification display requires device acceptance testing.
