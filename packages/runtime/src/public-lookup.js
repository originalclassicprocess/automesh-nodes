import { lookup } from 'node:dns';
import { isIP } from 'node:net';

// Fail closed on private, link-local, mapped, multicast and reserved answers.
// Check the complete DNS answer and pass the checked IP directly to net/tls;
// a separate preflight lookup would permit DNS rebinding during socket creation.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0) ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    const [a,b] = address.toLowerCase().split(':').map(x => parseInt(x || '0',16));
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8));
  }
  return false;
}
export function createPublicLookup(resolve = lookup) {
  return function publicLookup(hostname, options, callback) {
  resolve(hostname, { all: true, verbatim: true }, (error, records) => {
    if (error || !records?.length || records.some(r => !isPublicAddress(r.address))) {
      callback(new Error('courier_route_address_denied')); return;
    }
    const family = typeof options === 'number' ? options : options?.family;
    const matches = records.filter(r => !family || r.family === family);
    if (!matches.length) { callback(new Error('courier_route_address_denied')); return; }
    if (options?.all) callback(null, matches);
    else callback(null, matches[0].address, matches[0].family);
  });
  };
}
export const publicLookup = createPublicLookup();
