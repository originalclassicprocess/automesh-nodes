# Courier prekey directory — node 0.4.7

Optional `automesh-courier-prekeys-v1`, announced by authenticated `/outbox/status`
as `prekeyProtocol`. Existing courier jobs, receipts, routes and signaling wire
labels are unchanged. This is a client-to-node HTTP service, not node federation.

Each receiver creates private HPKE keys locally and uploads only individually
identity-signed public certificates with `courierBytes('prekey', body)`. A
certificate binds owner, permitted sender, key ID/public key, node URL/nodeId,
issuance, publication deadline and retention deadline. Publication is seven days;
retention is seven more days. A fresh assignment has up to seven days for delivery.

All endpoints use the existing fresh node challenge/account proof and CORS rules:

| Endpoint | Caller / effect |
| --- | --- |
| `/prekeys/status` | Bound receiver; its own per-contact available IDs and capacity |
| `/prekeys/publish` | Bound receiver; append signed public keys, retain available IDs explicitly |
| `/prekeys/allocate` | Authenticated permitted sender; `{owner, reservation: messageUUID}` |
| `/prekeys/revoke` | Bound receiver; stop future allocation for this contact |

Allocation is serialized and committed with fsync/atomic rename before reply.
The same sender/message returns the same key and deadline after lost replies or
restart. Used keys cannot be returned to the pool by re-publication. A signature
for a different owner, sender or node does not authorize issuance. Uncertain disk
commits disable the directory until restart; existing courier queues remain.

Available keys expire at their publication deadline. Assignments survive until
their delivery deadline. Revocation retains already assigned records to prevent
reuse. Missing private keys after restoring a client backup withdraw only free
keys. If directory state is lost, the client generates fresh additions rather
than reusing local keys that might have been assigned before the loss.

Target stock is 32 keys per contact; a stock of five or fewer gets replenishment
priority while the receiver's main client is unlocked. No server generation of
user private keys, seed upload or ability to decrypt messages is introduced.
An offline receiver can use its prepaid stock, which is finite.

Public metadata is stored privately under `courier-prekeys/` and included in the
node's data backup. Maximum 50 contacts per bound receiver, 4096 records per
receiver and a directory budget of at most 8 MiB / one eighth of node capacity.
Capacity hints let the client avoid generating private keys when the directory
cannot accept them. All metadata counts toward the node's aggregate byte quota.

Only recipients who have provided a signed service locator can be queried.
Public HTTPS discovery or an explicitly saved matching nodeId is required.
Fresh recipient-signed routes can accompany replies and use the existing route
update API. No bridge discovery, federation storage or new server-server calls
are added. Legacy nodes/peers retain the old exchange path. Additional-device
directories are unchanged. The receiver must have the updated main client;
the sender's ordinary courier node can remain on the existing wire version.

New client private state is v2 to prevent older readers from re-advertising
directory keys or prematurely pruning retained secrets. New clients read v1;
old clients must not open the upgraded local store. This does not change account
identity or seed. Existing prepared envelopes keep their original deadlines.

## 0.4.9: non-reserving availability

Authenticated POST `/prekeys/availability` accepts `{owner}`. Only the authenticated caller's correspondent record for that owner is counted; no owner membership is required for the caller. The owner must be a linked node member. Response: `{protocol: automesh-courier-prekeys-v1, available: 0..32}`. Empty/missing/revoked correspondent stock returns zero. Observing the inventory does not allocate or reserve a key. The count is a snapshot, not a reservation or a proof that private keys still exist on a receiver. No private keys or other correspondents are exposed.
