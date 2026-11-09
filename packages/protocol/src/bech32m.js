// MeshAutonomy account IDs: Bech32m("mesh", version byte || 20-byte fingerprint).
// The separator "1" in "mesh1" is not the version number.
const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const checksumConstant = 0x2bc830a3;
const hrp = 'mesh';
const version = 1;

/** @param {number[]} values */
function polymod(values) {
  let check = 1;
  for (const value of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) check ^= generators[i];
    }
  }
  return check >>> 0;
}

/** @param {string} value */
function expandHrp(value) {
  const chars = [...value].map((character) => character.charCodeAt(0));
  return [...chars.map((code) => code >>> 5), 0, ...chars.map((code) => code & 31)];
}

/** @param {number[]} data */
function checksum(data) {
  const value = (polymod([...expandHrp(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ checksumConstant) >>> 0;
  return Array.from({ length: 6 }, (_, i) => (value >>> (5 * (5 - i))) & 31);
}

/** @param {number[] | Uint8Array} values @param {number} from @param {number} to @param {boolean} pad */
function convertBits(values, from, to, pad) {
  let accumulator = 0;
  let bits = 0;
  const mask = (1 << to) - 1;
  /** @type {number[]} */
  const result = [];
  for (const value of values) {
    if (value < 0 || value >= (1 << from)) return null;
    accumulator = ((accumulator << from) | value) & 0xffff;
    bits += from;
    while (bits >= to) {
      bits -= to;
      result.push((accumulator >>> bits) & mask);
    }
  }
  if (pad) {
    if (bits > 0) result.push((accumulator << (to - bits)) & mask);
  } else if (bits >= from || ((accumulator << (to - bits)) & mask) !== 0) {
    return null;
  }
  return result;
}

/** @param {Uint8Array} fingerprint Exactly 20 bytes. */
export function encodeAccountId(fingerprint) {
  if (!(fingerprint instanceof Uint8Array) || fingerprint.length !== 20) {
    throw new Error('invalid_account_fingerprint');
  }
  const payload = new Uint8Array(21);
  payload[0] = version;
  payload.set(fingerprint, 1);
  const data = convertBits(payload, 8, 5, true);
  if (!data) throw new Error('invalid_account_fingerprint');
  return `${hrp}1${[...data, ...checksum(data)].map((digit) => alphabet[digit]).join('')}`;
}

/** @param {unknown} address @returns {Uint8Array | null} */
export function decodeAccountId(address) {
  if (typeof address !== 'string' || !address.startsWith(`${hrp}1`) || address.length !== 45) return null;
  const characters = address.slice(hrp.length + 1);
  const digits = [...characters].map((character) => alphabet.indexOf(character));
  if (digits.some((digit) => digit < 0)) return null;
  if (polymod([...expandHrp(hrp), ...digits]) !== checksumConstant) return null;
  const bytes = convertBits(digits.slice(0, -6), 5, 8, false);
  if (!bytes || bytes.length !== 21 || bytes[0] !== version) return null;
  const fingerprint = new Uint8Array(bytes.slice(1));
  return encodeAccountId(fingerprint) === address ? fingerprint : null;
}

/** @param {unknown} address */
export function isValidAccountId(address) {
  return decodeAccountId(address) !== null;
}
