# Notification upload readiness follow-up

The notification wake capability is available to home nodes as well as server
nodes. It still forwards only client-signed wakes to approved application origins,
only after courier storage completes. LAN-only submissions never forward a wake
to the Internet. Existing courier job/encryption/receipt formats are unchanged.

Installed older home nodes do not acquire this capability from an app update.
While the sending app remains open, its post-storage fallback can notify without
a node update. Autonomous notification retries after sender closure require a
home-node package containing this change. No installed personal node is modified
by this source change.
