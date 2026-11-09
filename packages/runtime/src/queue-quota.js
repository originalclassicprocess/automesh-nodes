export const QUEUE_LIMIT_REASONS = new Set(['node_files','profile_files','storage','node_messages','profile_messages']);
export const UPLOAD_IDLE_MS = 60 * 60 * 1000;
export function queueLimit(reason) {
  if (!QUEUE_LIMIT_REASONS.has(reason)) throw new Error('invalid_queue_limit');
  return Object.assign(new Error('mailbox_full'), { limit: reason });
}
// Keep space for ordinary text instead of allowing new file reservations to
// consume the whole node. Existing reservations are never evicted for this.
export const textReserve = maxBytes => Math.min(8 * 1024 * 1024, Math.floor(maxBytes / 8));
