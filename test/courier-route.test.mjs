import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPublicAddress, createPublicLookup } from '../packages/runtime/src/public-lookup.js';
import { Courier } from '../packages/runtime/src/courier.js';
import { COURIER_ROUTE_PROTOCOL, MAX_DISCOVERED_ROUTES } from '../packages/protocol/src/courier-route.js';
import { ATTACHMENT_PROTOCOL, ATTACHMENT_CHUNK_BYTES, COURIER_PROTOCOL, courierBytes } from '../packages/protocol/src/index.js';
import { identity, job, protector } from './fixtures.mjs';

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

test('serves stored file parts to two recipients on their signed routes without the uploading client', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automesh-file-routes-'));
  const options = { maxBytes:1024*1024, lanEnabled:true, secretProtector:protector() };
  const [sender, bob, carol] = await Promise.all([identity(), identity(), identity()]);
  const sign = async (actor, purpose, body) => ({ body, publicKey:actor.publicKey,
    signature:Buffer.from(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, actor.keys.privateKey,
      courierBytes(purpose,body))).toString('hex') });
  let courier;
  try {
    courier = await new Courier(directory,options).initialize();
    const files = [];
    for (const [recipient, name] of [[bob,'bob'],[carol,'carol']]) {
      const url = 'wss://' + name + '.example/signal', now = Date.now();
      await courier.rememberRoute(sender.address,await sign(recipient,'route',{
        protocol:COURIER_ROUTE_PROTOCOL, kind:'signaling', from:recipient.address, to:sender.address,
        signalingUrl:url, issuedAt:now, expiresAt:now+60_000 }));
      const bytes = randomBytes(37), id = randomBytes(16).toString('hex');
      const value = await job(courier.address,sender,recipient,{protocol:ATTACHMENT_PROTOCOL,id,size:21,bytes:37,chunks:1,
        chunkBytes:ATTACHMENT_CHUNK_BYTES,digest:createHash('sha256').update(bytes).digest('hex')});
      await courier.startFile(sender.address,value);
      await courier.attachments.put(sender.address,id,0,bytes.toString('base64url'));
      await courier.put(sender.address,value);
      files.push({recipient,url,id,bytes,value});
    }
    await courier.close();
    courier = await new Courier(directory,options).initialize();
    const frames = [];
    courier.send = (route, frame) => { frames.push({url:route.url,frame}); return true; };
    await courier.flush();
    const request = async (file, actor) => ({ from:actor.address, to:courier.address,
      request:await sign(actor,'attachment-request',{ protocol:ATTACHMENT_PROTOCOL, from:actor.address, to:courier.address,
        id:file.id, index:0, requestId:randomBytes(16).toString('hex'), expiresAt:Date.now()+30_000 }) });
    for (const file of files) {
      const route = courier.routes.get('discovered:' + file.url);
      assert.ok(route?.discovered);
      route.ready = true;
      route.online.add(file.recipient.address);
    }
    await courier.flush();
    for (const file of files) {
      const route = courier.routes.get('discovered:' + file.url);
      assert.ok(frames.some(({url,frame}) => url === file.url && frame.type === 'courier_delivery' && frame.job.body.id === file.value.body.id));
      await courier.sendFilePart(route,await request(file,file.recipient));
      assert.equal(frames.at(-1).frame.cipher,file.bytes.toString('base64url'));
    }
    const before = frames.length;
    const [b,c] = files, bobRoute = courier.routes.get('discovered:' + b.url), carolRoute = courier.routes.get('discovered:' + c.url);
    await courier.sendFilePart(carolRoute,await request(b,bob));
    await courier.sendFilePart(bobRoute,await request(b,carol));
    assert.equal(frames.length,before);
  } finally {
    await courier?.close();
    await rm(directory,{recursive:true,force:true});
  }
});
