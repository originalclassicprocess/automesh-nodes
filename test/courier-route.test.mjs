import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, createPublicLookup } from '../packages/runtime/src/public-lookup.js';
import { Courier } from '../packages/runtime/src/courier.js';
import { MAX_DISCOVERED_ROUTES } from '../packages/protocol/src/courier-route.js';
import { protector } from './fixtures.mjs';

test('automatic routes reject private, mapped, link-local and reserved DNS answers',async()=>{
  for(const address of ['127.0.0.1','10.1.2.3','0.0.0.0','100.64.0.1','172.16.0.1','192.168.1.1','169.254.169.254',
    '224.0.0.1','198.18.0.1','192.0.2.1','::1','::ffff:127.0.0.1','::ffff:7f00:1','fe80::1','fc00::1','2001:db8::1','2002:7f00::1'])
    assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true);
  let records=[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}];
  const lookup=createPublicLookup((_host,_options,callback)=>callback(null,records));
  const call=()=>new Promise((resolve,reject)=>lookup('node.example',{all:true},(error,answers)=>error?reject(error):resolve(answers)));
  await assert.rejects(call(),/courier_route_address_denied/);
  records=[{address:'8.8.8.8',family:4}];assert.deepEqual(await call(),records);
  // Every connection checks its own DNS answer, including a later rebinding.
  records=[{address:'169.254.169.254',family:4}];await assert.rejects(call(),/courier_route_address_denied/);
});
test('discovered sockets are bounded, scoped to signed jobs and removed when unused',()=>{
  const courier=new Courier('unused-test-directory',{maxBytes:1024*1024,secretProtector:protector()});
  courier.address='own-node';
  // This pure scheduling test uses already-validated records. Signature and
  // membership checks are exercised by real-node integration tests in the app.
  const records=Array.from({length:30},(_,i)=>({ciphertext:Buffer.from(JSON.stringify({body:{from:`sender-${i}`,to:`peer-${i}`,
    route:{body:{nodeAddress:`node-${i}`,signalingUrl:`wss://node-${i}.example/signal`,expiresAt:Date.now()+60000}}}})).toString('base64url')}));
  courier.syncDiscovered(records);
  assert.equal(courier.routes.size,MAX_DISCOVERED_ROUTES);
  assert.ok([...courier.routes.values()].every(r=>r.discovered));
  const privateRecords=records.map(record=>{const job=courier.decode(record);job.body.lanOnly=true;return{ciphertext:Buffer.from(JSON.stringify(job)).toString('base64url')};});
  courier.syncDiscovered(privateRecords);assert.equal(courier.routes.size,0);
  courier.syncDiscovered(records);courier.syncDiscovered([]);assert.equal(courier.routes.size,0);
});
