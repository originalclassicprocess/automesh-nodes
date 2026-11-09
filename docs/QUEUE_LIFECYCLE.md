# Courier queue lifecycle

Capability: `queueLifecycle: automesh-queue-v1` in authenticated outbox status.

Authenticated, member-only POST `/outbox/cancel` takes `{job}`. The caller must match the signed job author, courier identity, full digest and expiry. The original signed job is verified even after its deadline (without extending that deadline). A conflicting job is rejected. Returns `{status, canceled}`. `status` is canceled, expired or acknowledged. Acknowledged does not itself prove delivery; use the recipient-signed receipt from `/outbox/receipts`.

POST `/outbox/outcomes` takes `{ids}`: at most 50 compact 32-hex envelope IDs. It returns `{outcomes:[{id,digest,status}], checkedAt}` only for the authenticated author and canceled/expired jobs. `digest` is SHA-256 of the base64url-encoded signed job JSON, as stored in DiskMailbox. No user ciphertext or file bytes are included. These are node reports, not recipient signatures. `checkedAt` is the node clock after the sweep, allowing an absent expired job to finish without trusting a potentially fast client clock.

Terminal records retain replay protection and results for 30 days after completion. Total metadata is bounded by the mailbox record and byte limits. Ciphertext is removed on expiry/cancellation; cancellation deletes attachment bytes/reservations after the terminal record is committed. Recovery finishes file cleanup before forwarding. A late PUT or file/start must not recreate a canceled job. An already acknowledged record is preserved, including its signed receipt.

There is no administrative purge API. Node operators physically control their storage; the API restricts cancellation to the authenticated sender. Clients must persist cancellation intent, stop other retry paths, verify signed receipts first, and require explicit new UUID/key attempts to retry terminal sends. Dismissing a local counter is not a network operation.

Old node readers reject the new terminal statuses; roll back private state from a pre-upgrade backup together with code. Node-to-node routing is unchanged.
