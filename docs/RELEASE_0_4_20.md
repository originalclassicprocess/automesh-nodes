# Automesh Nodes 0.4.20

Enable the existing bounded signed notification wake relay on home-role nodes,
in addition to server nodes. Requests still require the courier author's account
signature, a matching recipient, active node membership and an operator-approved
HTTPS provider. LAN-only delivery remains local. Push credentials and message
content are never stored in the wake queue.

Confirmed outbox cancellation removes matching queued notification retries.
Existing courier, signaling and encrypted file formats are unchanged. Optional
notification failures do not prevent primary startup, storage or delivery.

Installed home nodes require a manual update for autonomous notification after
the sender closes. Publishing this release does not update personal nodes.
