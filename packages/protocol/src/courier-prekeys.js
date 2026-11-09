import {isValidAccountId} from './bech32m.js';
import {COURIER_TTL,courierId} from './courier-protocol.js';
export const COURIER_PREKEY_PROTOCOL='automesh-courier-prekeys-v1';
export const COURIER_PREKEY_PATHS=['/prekeys/status','/prekeys/publish','/prekeys/allocate','/prekeys/revoke','/prekeys/availability'];
export const PREKEY_TARGET=32,PREKEY_LOW=5,MAX_PRIVATE_COURIER_KEYS=4096;
export const MAX_DIRECTORY_KEYS=4096;
/** @param {any} value */
export function validateKeySource(value) {
  let url;try{url=new URL(value?.url);}catch{throw Error('invalid_prekey_source');}
  if(url.protocol!=='https:'||url.origin!==value.url||url.username||url.password||!/^[a-f0-9]{32}$/.test(value.nodeId)||
    Object.keys(value).sort().join(',')!=='nodeId,url')throw Error('invalid_prekey_source');
  return value;
}
// Publication expiry limits NEW encryption; retention covers delayed envelopes.
/** @param {any} acceptUntil @param {any} retainUntil */
export function validateKeyLifetime(acceptUntil,retainUntil,ttl=COURIER_TTL) {
  if(!Number.isSafeInteger(acceptUntil)||!Number.isSafeInteger(retainUntil)||ttl!==COURIER_TTL||retainUntil!==acceptUntil+ttl)
    throw Error('invalid_prekey_lifetime');
}
/** @param {any} value @param {string} owner @param {string} peer */
export function validatePrekey(value,owner,peer,now=Date.now(),allowRetained=false) {
  const b=value?.body;
  if(!b||b.protocol!==COURIER_PREKEY_PROTOCOL||b.from!==owner||b.to!==peer||!isValidAccountId(owner)||!isValidAccountId(peer)||owner===peer||
    !/^[a-f0-9]{32}$/.test(b.id)||!/^04[a-f0-9]{128}$/.test(b.publicKey)||!Number.isSafeInteger(b.issuedAt)||
    b.issuedAt<0||b.issuedAt>now+300000||b.acceptUntil!==b.issuedAt+COURIER_TTL||b.retainUntil<=now||(!allowRetained&&b.acceptUntil<=now)||
    !/^04[a-f0-9]{128}$/.test(value.publicKey)||!/^[a-f0-9]{128}$/.test(value.signature)||
    Object.keys(value).sort().join(',')!=='body,publicKey,signature'||
    Object.keys(b).sort().join(',')!=='acceptUntil,deliveryTtlMs,from,id,issuedAt,node,protocol,publicKey,retainUntil,to')throw Error('invalid_prekey');
  validateKeySource(b.node);validateKeyLifetime(b.acceptUntil,b.retainUntil,b.deliveryTtlMs);return value;
}
/** @param {any} value @param {string} owner @param {string} peer @param {string} reservation */
export function validateAllocation(value,owner,peer,reservation,now=Date.now()) {
  if(value?.protocol!==COURIER_PREKEY_PROTOCOL||value.reservation!==reservation||!courierId(reservation))throw Error('invalid_prekey_allocation');
  const b=validatePrekey(value.key,owner,peer,now,true).body;
  if(!Number.isSafeInteger(value.allocatedAt)||value.allocatedAt<0||value.allocatedAt<b.issuedAt-300000||value.allocatedAt>b.acceptUntil||value.allocatedAt>now+300000||
    value.expiresAt!==value.allocatedAt+COURIER_TTL||value.expiresAt>b.retainUntil||value.expiresAt<=now)throw Error('invalid_prekey_allocation');
  return value;
}
