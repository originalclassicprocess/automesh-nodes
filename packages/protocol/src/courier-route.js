import { isValidAccountId } from './bech32m.js';

export const COURIER_ROUTE_PROTOCOL = 'automesh-courier-route-v1';
export const COURIER_ROUTE_TTL = 7 * 86400000;
export const MAX_DISCOVERED_ROUTES = 12;

// Automatic discovery is limited to public DNS names on standard TLS. Literal
// IPs, local names, custom ports and credentials remain explicit operator routes.
// The runtime MUST additionally check every DNS result at socket connection time.
/** @param {unknown} value */
export function publicCourierSignal(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('invalid_courier_route');
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.port || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/signal' || url.href !== value || !url.hostname.includes('.') || !/[a-z]/i.test(url.hostname) ||
      url.hostname.startsWith('[') || /\.(?:local|localhost|internal|test|invalid)$/.test(url.hostname)) throw new Error('invalid_courier_route');
  return url.href;
}

// This is structure validation, not signature verification or permission to
// connect. A route is signed with courierBytes('route', body) by its recipient.
/** @param {any} route @param {string} recipient @param {string} sender @param {number} now */
export function validateCourierRoute(route, recipient, sender, now = Date.now()) {
  const b = route?.body;
  if (!b || b.protocol !== COURIER_ROUTE_PROTOCOL || b.from !== recipient || b.to !== sender ||
      !isValidAccountId(recipient) || !isValidAccountId(sender) || recipient === sender ||
      (b.kind !== undefined && b.kind !== 'signaling') ||
      (b.kind === 'signaling' ? b.nodeAddress !== undefined || b.nodeId !== undefined : !isValidAccountId(b.nodeAddress) || !/^[a-f0-9]{32}$/.test(b.nodeId)) ||
      !Number.isSafeInteger(b.issuedAt) || b.issuedAt < 0 || b.issuedAt > now + 300000 ||
      !Number.isSafeInteger(b.expiresAt) || b.expiresAt <= now || b.expiresAt <= b.issuedAt ||
      b.expiresAt - b.issuedAt > COURIER_ROUTE_TTL ||
      typeof route.publicKey !== 'string' || !/^04[a-f0-9]{128}$/.test(route.publicKey) ||
      typeof route.signature !== 'string' || !/^[a-f0-9]{128}$/.test(route.signature) || JSON.stringify(route).length > 2048)
    throw new Error('invalid_courier_route');
  publicCourierSignal(b.signalingUrl);
  return route;
}
