import { isValidAccountId } from './bech32m.js';
import { validateAttachment } from './attachment-protocol.js';
import { validateCourierRoute } from './courier-route.js';
export const COURIER_PROTOCOL = 'automesh-courier-v1';
// Two bounded base64 layers around a normal 64 KiB chat payload.
export const COURIER_MAX_PACKET = 120 * 1024;
export const COURIER_TTL = 7 * 86400000;
/** @param {string} purpose @param {unknown} body */
export const courierBytes = (purpose, body) => new TextEncoder().encode(JSON.stringify([COURIER_PROTOCOL, purpose, body]));
/** @param {unknown} value */
export const courierId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
/** @param {any} job @param {string} courier @param {number} now */
export function validateCourierJob(job, courier, now = Date.now()) {
  const b = job?.body;
  if (!b || b.protocol !== COURIER_PROTOCOL || b.courier !== courier || !isValidAccountId(b.from) || !isValidAccountId(b.to) ||
      b.from === b.to || (b.lanOnly !== undefined && typeof b.lanOnly !== 'boolean') || !courierId(b.id) || typeof b.packet !== 'string' || !/^[A-Za-z0-9_-]+$/.test(b.packet) ||
      b.packet.length > COURIER_MAX_PACKET || !Number.isSafeInteger(b.expiresAt) || b.expiresAt <= now || b.expiresAt > now + COURIER_TTL ||
      typeof job.publicKey !== 'string' || !/^04[a-f0-9]{128}$/.test(job.publicKey) ||
      typeof job.signature !== 'string' || !/^[a-f0-9]{128}$/.test(job.signature)) throw new Error('invalid_courier_job');
  if (b.attachment !== undefined) validateAttachment(b.attachment);
  if (b.route !== undefined) {
    validateCourierRoute(b.route, b.to, b.from, now);
    if (b.lanOnly || b.attachment || b.expiresAt > b.route.body.expiresAt) throw new Error('invalid_courier_route');
  }
  return job;
}
/** @param {string} value @param {boolean} test */
export function courierRelayUrl(value, test = false) {
  const url = new URL(value);
  if ((url.protocol !== 'wss:' && !(test && url.protocol === 'ws:' && url.hostname === '127.0.0.1')) ||
      url.username || url.password || url.hash || url.search || url.pathname !== '/signal' || url.href !== value || value.length > 512)
    throw new Error('invalid_courier_relay');
  return value;
}
