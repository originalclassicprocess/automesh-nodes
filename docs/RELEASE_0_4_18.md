# Automesh Nodes 0.4.18

Adds an optional, online-only secure introduction relay to authenticated signaling sockets. Updated clients can exchange a first contact request, consent and delivery keys when WebRTC is unavailable. End-to-end authentication and encryption remain client responsibilities; signaling fixes the authenticated sender and bounds frame size and sender/recipient rates.

This is not a general chat/file relay, offline invitation inbox or node federation. Existing direct signaling, courier queues, files, permissions and local state are preserved. Old clients keep their current delivery paths. Upgrading a node does not automatically accept contacts or grant access to its courier queue.

Validated with protocol bounds, authenticated signaling and existing queue/delivery regression tests. Mobile/VPN conditions still require field testing.
