import { isValidAccountId } from './bech32m.js';
import { COURIER_TTL } from './courier-protocol.js';
export const RECIPIENT_INBOX_PROTOCOL='automesh-recipient-inbox-v1';
export const RECIPIENT_INBOX_PATHS=['/receive/list','/receive/file/parts','/receive/ack'];
// Owner-issued capability AND recipient authentication are both mandatory.
// No membership, outbox rights, quota or access to another sender is granted.
/** @param {any} grant
 * @param {string} courier
 * @param {string} nodeId
 * @param {string} recipient
 * @param {number} [now]
 */
export function validateRecipientGrant(grant,courier,nodeId,recipient,now=Date.now()){
  const b=grant?.body;
  if(!b||b.protocol!==RECIPIENT_INBOX_PROTOCOL||b.courier!==courier||b.nodeId!==nodeId||b.to!==recipient||
    !isValidAccountId(b.from)||!isValidAccountId(b.to)||b.from===b.to||!isValidAccountId(b.courier)||!/^[a-f0-9]{32}$/.test(b.nodeId)||
    !Number.isSafeInteger(b.issuedAt)||b.issuedAt<0||!Number.isSafeInteger(b.expiresAt)||b.issuedAt>now+300000||b.expiresAt<=now||
    b.expiresAt<=b.issuedAt||b.expiresAt-b.issuedAt>2*COURIER_TTL||
    !/^04[a-f0-9]{128}$/.test(grant.publicKey)||!/^[a-f0-9]{128}$/.test(grant.signature))throw Error('invalid_recipient_grant');
  return grant;
}
