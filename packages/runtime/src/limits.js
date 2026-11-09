// Only connection setup is signaling traffic; chat/files use DataChannels.
// The buckets retain no account or IP metadata.
export function tokenBucket(rate, burst, now = Date.now) {
  if (!(rate > 0 && burst > 0)) throw new Error('invalid_rate_limit');
  let tokens = burst;
  let updated = now();
  return (cost = 1) => {
    const time = now();
    tokens = Math.min(burst, tokens + Math.max(0, time - updated) * rate / 1000);
    updated = time;
    if (cost > tokens) return false;
    tokens -= cost;
    return true;
  };
}
