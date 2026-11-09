import { isValidAccountId } from './bech32m.js';
import { accountIdFromPublicKey } from './account-id.js';
export const DEVICE_DIRECTORY = 'automesh-device-directory-v2';
export const DIRECTORY_LIFETIME = 30 * 86400000;
export const DEVICE_MAIL_TTL = 7 * 86400000;
export const DEVICE_PATHS = ['/devices/publish', '/devices/policy', '/devices/keys', '/devices/allocate', '/devices/put', '/devices/list', '/devices/ack', '/devices/receipts', '/devices/grant'];
const encoder = new TextEncoder();
/** @param {any} value @param {string[]} keys */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
/** @param {any} value */
export function deviceCanonical(value) {
  let count = 0;
  /** @param {any} item @param {number} depth @returns {any} */
  function visit(item, depth) {
    if (++count > 4096 || depth > 16) throw new Error('invalid_device_object');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object') throw new Error('invalid_device_object');
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) throw new Error('invalid_device_object');
      const values = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('invalid_device_object');
        values.push(visit(descriptor.value, depth + 1));
      }
      return '[' + values.join(',') + ']';
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('invalid_device_object');
    const output = [], keys = Reflect.ownKeys(item);
    if (keys.some(k => typeof k !== 'string')) throw new Error('invalid_device_object');
    for (const key of keys.sort()) {
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key) || !property?.enumerable || !('value' in property)) throw new Error('invalid_device_object');
      output.push(JSON.stringify(key) + ':' + visit(property.value, depth + 1));
    }
    return '{' + output.join(',') + '}';
  }
  const result = visit(value, 0);
  if (encoder.encode(result).length > 65536) throw new Error('invalid_device_object');
  return result;
}
/** @param {Uint8Array} bytes */
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
/** @param {string} value */
const unhex = value => Uint8Array.from(value.match(/../g) || [], b => parseInt(b, 16));
/** @param {any} object @param {SubtleCrypto} subtle */
export async function deviceObjectDigest(object, subtle = crypto.subtle) {
  return hex(new Uint8Array(await subtle.digest('SHA-256', encoder.encode(deviceCanonical({ record: object.record, publicKey: object.publicKey })))));
}
/** @param {any} object @param {string} author @param {number} at @param {SubtleCrypto} subtle */
async function verifyCore(object, author, at, subtle) {
  if (!exact(object, ['record', 'publicKey', 'signature']) || !/^04[a-f0-9]{128}$/.test(object.publicKey) || !/^[a-f0-9]{128}$/.test(object.signature)) throw new Error('invalid_device_signature');
  const r = object.record;
  if (!exact(r, ['version', 'id', 'kind', 'author', 'createdAt', 'expiresAt', 'audience', 'body']) || r.version !== 1 || r.kind !== 'document' || r.author !== author ||
    !isValidAccountId(author) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(r.id) || !Number.isSafeInteger(r.createdAt) || r.createdAt < 0 || r.createdAt > at ||
    !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= at || !Array.isArray(r.audience) || r.audience.length > 1 || r.audience.some(/** @param {any} a */ a => !isValidAccountId(a))) throw new Error('invalid_device_roster');
  const raw = unhex(object.publicKey);
  if (await accountIdFromPublicKey(raw, subtle) !== author) throw new Error('invalid_device_signature');
  const key = await subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unhex(object.signature), encoder.encode('Automesh signed object v1\0' + deviceCanonical(r)))) throw new Error('invalid_device_signature');
}
/** @param {any} value @param {string} owner @param {number} now @param {SubtleCrypto} subtle */
export async function verifyDirectoryRoster(value, owner, now = Date.now(), subtle = crypto.subtle) {
  const roster = JSON.parse(deviceCanonical(value)); await verifyCore(roster, owner, now, subtle);
  const r = roster.record, b = r.body, authority = b?.directory;
  if (r.audience.length || r.expiresAt - r.createdAt > DIRECTORY_LIFETIME || !exact(b, ['type', 'sequence', 'previous', 'epoch', 'primary', 'devices', 'directory']) ||
    b.type !== DEVICE_DIRECTORY || b.epoch !== 0 || typeof b.primary !== 'boolean' || !Number.isSafeInteger(b.sequence) || b.sequence < 1 ||
    (b.sequence === 1 ? b.previous !== null : !/^[a-f0-9]{64}$/.test(b.previous)) || !exact(authority, ['url', 'nodeId', 'publicKey']) ||
    !/^[a-f0-9]{32}$/.test(authority.nodeId) || !/^04[a-f0-9]{128}$/.test(authority.publicKey) || !Array.isArray(b.devices) || b.devices.length > 16) throw new Error('invalid_device_roster');
  const url = new URL(authority.url);
  if (url.protocol !== 'https:' || url.origin !== authority.url || url.username || url.password || authority.url.length > 512) throw new Error('invalid_device_authority');
  const ids = new Set(), addresses = new Set(), requests = new Set();
  for (const member of b.devices) {
    if (!exact(member, ['certificate', 'revokedAt'])) throw new Error('invalid_device_roster');
    const cert = member.certificate, issued = cert?.record?.createdAt;
    if (!Number.isSafeInteger(issued) || issued > r.createdAt) throw new Error('invalid_device_roster');
    await verifyCore(cert, owner, issued, subtle); const c = cert.record, grant = c.body;
    if (!exact(grant, ['type', 'device', 'devicePublicKey', 'requestId', 'requestHash', 'label', 'epoch', 'permission', 'canDelegate']) ||
      grant.type !== 'automesh-device-certificate-prototype-v1' || c.expiresAt - issued > DIRECTORY_LIFETIME ||
      !isValidAccountId(grant.device) || grant.device === owner || c.audience.length !== 1 || c.audience[0] !== grant.device ||
      !/^04[a-f0-9]{128}$/.test(grant.devicePublicKey) || await accountIdFromPublicKey(unhex(grant.devicePublicKey), subtle) !== grant.device ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(grant.requestId) || !/^[a-f0-9]{64}$/.test(grant.requestHash) || grant.epoch !== 0 ||
      grant.permission !== 'messages' || grant.canDelegate !== false || typeof grant.label !== 'string' || !grant.label || grant.label.length > 64 || /[\u0000-\u001f\u007f]/.test(grant.label) ||
      (member.revokedAt !== null && (!Number.isSafeInteger(member.revokedAt) || member.revokedAt < issued || member.revokedAt > r.createdAt)) ||
      ids.has(c.id) || addresses.has(grant.device) || requests.has(grant.requestId)) throw new Error('invalid_device_roster');
    ids.add(c.id); addresses.add(grant.device); requests.add(grant.requestId);
  }
  return roster;
}
/** @param {any} roster @param {string} device @param {number} now */
export function directoryMember(roster, device, now = Date.now()) {
  if (roster.record.expiresAt <= now) return false;
  if (device === roster.record.author) return roster.record.body.primary === true;
  return roster.record.body.devices.some(/** @param {any} m */ m => m.revokedAt === null && m.certificate.record.expiresAt > now && m.certificate.record.body.device === device);
}
/** @param {string} purpose @param {any} body */
export const deviceSigningBytes = (purpose, body) => encoder.encode(deviceCanonical(['automesh-device-transport-v2', purpose, body]));
/** @param {any} signed @param {string} purpose @param {string} address @param {SubtleCrypto} subtle */
export async function verifyDeviceTransport(signed, purpose, address, subtle = crypto.subtle) {
  const snapshot = JSON.parse(deviceCanonical(signed));
  if (!exact(snapshot, ['body', 'publicKey', 'signature']) || !/^04[a-f0-9]{128}$/.test(snapshot.publicKey) || !/^[a-f0-9]{128}$/.test(snapshot.signature)) throw new Error('invalid_device_signature');
  const raw = unhex(snapshot.publicKey);
  if (await accountIdFromPublicKey(raw, subtle) !== address) throw new Error('invalid_device_signature');
  const key = await subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unhex(snapshot.signature), deviceSigningBytes(purpose, snapshot.body))) throw new Error('invalid_device_signature');
  return snapshot;
}
