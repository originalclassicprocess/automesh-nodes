import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,webcrypto,createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {CourierPrekeys} from '../packages/runtime/src/prekeys.js';
import {writeAtomic} from '../packages/runtime/src/files.js';
import {createNodeService} from '../packages/runtime/src/index.js';
import {COURIER_PREKEY_PROTOCOL,validateAllocation} from '../packages/protocol/src/courier-prekeys.js';
import {COURIER_TTL,courierBytes} from '../packages/protocol/src/courier-protocol.js';
import {nodeProofBytes} from '../packages/protocol/src/protocol.js';
import {identity,protector} from './fixtures.mjs';
const roots=[],services=[];
const directory=async()=>{const p=await mkdtemp(join(tmpdir(),'automesh-prekeys-'));roots.push(p);return p;};
afterEach(async()=>{for(const s of services.splice(0))await s.close();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function certificate(owner,peer,node,now=Date.now()){
  const pair=await webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const body={protocol:COURIER_PREKEY_PROTOCOL,from:owner.address,to:peer.address,id:randomBytes(16).toString('hex'),
    publicKey:Buffer.from(await webcrypto.subtle.exportKey('raw',pair.publicKey)).toString('hex'),issuedAt:now,
    acceptUntil:now+COURIER_TTL,retainUntil:now+2*COURIER_TTL,deliveryTtlMs:COURIER_TTL,node};
  return {body,publicKey:owner.publicKey,signature:Buffer.from(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},owner.keys.privateKey,courierBytes('prekey',body))).toString('hex')};
}
async function fixture(){
  let now=Date.now();const [owner,peer,other]=await Promise.all([identity(),identity(),identity()]),path=await directory(),node={url:'https://node.example',nodeId:'a'.repeat(32)};
  let member=true;const options={nodeId:node.nodeId,isMember:address=>member&&address===owner.address,now:()=>now};
  const store=await new CourierPrekeys(path,options).initialize();
  return {owner,peer,other,path,node,options,store,setNow:value=>now=value,now:()=>now,revokeMember:()=>member=false};
}

test('lost allocation replies and restart return the same key; other messages consume different keys',async()=>{
  const f=await fixture(),keys=await Promise.all(Array.from({length:3},()=>certificate(f.owner,f.peer,f.node)));
  await f.store.publish(f.owner.address,{peer:f.peer.address,keys,keep:[]});
  const reservation=randomUUID(),first=await f.store.allocate(f.peer.address,{owner:f.owner.address,reservation});
  validateAllocation(first,f.owner.address,f.peer.address,reservation);
  const restarted=await new CourierPrekeys(f.path,f.options).initialize();
  assert.deepEqual(await restarted.allocate(f.peer.address,{owner:f.owner.address,reservation}),first);
  const second=await restarted.allocate(f.peer.address,{owner:f.owner.address,reservation:randomUUID()});assert.notEqual(first.key.body.id,second.key.body.id);
  assert.equal((await restarted.status(f.owner.address,f.peer.address)).available.length,1);
  await assert.rejects(restarted.allocate(f.other.address,{owner:f.owner.address,reservation:randomUUID()}),/prekeys_unavailable/);
  const disk=(await Promise.all((await readdir(f.path)).map(name=>readFile(join(f.path,name),'utf8')))).join('');
  assert.doesNotMatch(disk,/privateKey|mnemonic|seed/);
});

test('publication rotation preserves claims and cannot return claimed keys to the pool',async()=>{
  const f=await fixture(),key=await certificate(f.owner,f.peer,f.node);await f.store.publish(f.owner.address,{peer:f.peer.address,keys:[key],keep:[]});
  const request={owner:f.owner.address,reservation:randomUUID()},claim=await f.store.allocate(f.peer.address,request);
  await f.store.publish(f.owner.address,{peer:f.peer.address,keys:[key],keep:[]});
  assert.equal((await f.store.status(f.owner.address,f.peer.address)).available.length,0);
  await assert.rejects(f.store.allocate(f.peer.address,{owner:f.owner.address,reservation:randomUUID()}),/prekeys_unavailable/);
  await f.store.revoke(f.owner.address,f.peer.address);
  await assert.rejects(f.store.allocate(f.peer.address,request),/prekeys_unavailable/);
  const fresh=await certificate(f.owner,f.peer,f.node);await f.store.publish(f.owner.address,{peer:f.peer.address,keys:[fresh],keep:[]});
  assert.deepEqual(await f.store.allocate(f.peer.address,request),claim);
  assert.equal((await f.store.status(f.owner.address,f.peer.address)).available.length,1);
});

test('old backups withdraw unavailable public keys without erasing claims; owner removal frees metadata',async()=>{
  const f=await fixture(),keys=await Promise.all([certificate(f.owner,f.peer,f.node),certificate(f.owner,f.peer,f.node)]);
  await f.store.publish(f.owner.address,{peer:f.peer.address,keys,keep:[]});
  const request={owner:f.owner.address,reservation:randomUUID()},claim=await f.store.allocate(f.peer.address,request);
  await f.store.publish(f.owner.address,{peer:f.peer.address,keys:[],keep:[]});
  assert.equal((await f.store.status(f.owner.address,f.peer.address)).available.length,0);
  assert.deepEqual(await f.store.allocate(f.peer.address,request),claim);
  f.revokeMember();await f.store.sweep();assert.equal(f.store.stats().bytes,0);
});

test('retention is independent: a key issued six days ago still supports seven days of delivery',async()=>{
  const f=await fixture(),issued=f.now()-6*86400000,key=await certificate(f.owner,f.peer,f.node,issued);
  await f.store.publish(f.owner.address,{peer:f.peer.address,keys:[key],keep:[]});
  const request={owner:f.owner.address,reservation:randomUUID()},claim=await f.store.allocate(f.peer.address,request);
  assert.equal(claim.expiresAt,f.now()+COURIER_TTL);
  f.setNow(f.now()+2*86400000);const restarted=await new CourierPrekeys(f.path,f.options).initialize();
  assert.deepEqual(await restarted.allocate(f.peer.address,request),claim);
  await assert.rejects(restarted.allocate(f.peer.address,{owner:f.owner.address,reservation:randomUUID()}),/prekeys_unavailable/);
  f.setNow(claim.expiresAt);await restarted.sweep();assert.equal(restarted.stats().bytes,0);
});

test('forged, cross-owner, secret-bearing and wrong-node certificates are rejected',async()=>{
  const f=await fixture(),key=await certificate(f.owner,f.peer,f.node);
  for(const changed of [{...key,signature:'0'.repeat(128)},{...key,privateKey:'must-not-store'},
    {...key,body:{...key.body,from:f.other.address}},{...key,body:{...key.body,node:{...f.node,nodeId:'b'.repeat(32)}}},
    {...key,body:{...key.body,retainUntil:key.body.retainUntil+1}}])
    await assert.rejects(f.store.publish(f.owner.address,{peer:f.peer.address,keys:[changed],keep:[]}));
  await assert.rejects(f.store.publish(f.peer.address,{peer:f.owner.address,keys:[key],keep:[]}));assert.equal(f.store.stats().bytes,0);
});

test('ambiguous durable write failure disables issuance until restart, without reusing a key',async()=>{
  const f=await fixture(),key=await certificate(f.owner,f.peer,f.node);await f.store.publish(f.owner.address,{peer:f.peer.address,keys:[key],keep:[]});
  const failing=await new CourierPrekeys(f.path,{...f.options,write:async(...args)=>{await writeAtomic(...args);throw Error('directory_sync_failed');}}).initialize();
  const request={owner:f.owner.address,reservation:randomUUID()};await assert.rejects(failing.allocate(f.peer.address,request),/directory_sync_failed/);
  await assert.rejects(failing.allocate(f.peer.address,{owner:f.owner.address,reservation:randomUUID()}),/prekey_unavailable/);
  const restarted=await new CourierPrekeys(f.path,f.options).initialize();
  assert.equal((await restarted.allocate(f.peer.address,request)).key.body.id,key.body.id);
  await assert.rejects(restarted.allocate(f.peer.address,{owner:f.owner.address,reservation:randomUUID()}),/prekeys_unavailable/);
});

test('signed HTTP allocation is isolated and atomic for simultaneous non-member senders',async()=>{
  const hosts=['127.0.0.1:0'],service=await createNodeService({directory:await directory(),hosts,origins:['http://localhost:5173'],adminToken:'a'.repeat(64),secretProtector:protector(),testHttp:true,localRouteScope:'internet'});services.push(service);
  const listener=service.createPublicServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');hosts.push('127.0.0.1:'+listener.address().port);const url='http://'+hosts[1];
  const [owner,peer,other]=await Promise.all([identity(),identity(),identity()]);
  await service.state.change(s=>{s.owner={address:owner.address,publicKey:owner.publicKey};s.members=[{...s.owner,senders:[]}];});
  const api=async(who,path,body)=>{
    const bytes=JSON.stringify(body),digest=createHash('sha256').update(bytes).digest('hex');
    const challenge=await(await fetch(url+'/node/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({address:who.address,method:'POST',path,digest})})).json();
    const proof={address:who.address,publicKey:who.publicKey,challenge:challenge.challenge,signature:Buffer.from(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},who.keys.privateKey,nodeProofBytes(challenge.nodeId,who.address,challenge.challenge,'POST',path,digest))).toString('hex')};
    const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Automesh-Proof':Buffer.from(JSON.stringify(proof)).toString('base64url')},body:bytes});return {status:r.status,value:await r.json()};
  };
  const keys=await Promise.all(Array.from({length:4},()=>certificate(owner,peer,{url:'https://node.example',nodeId:service.state.value.nodeId})));
  assert.equal((await api(owner,'/prekeys/publish',{peer:peer.address,keys,keep:[]})).status,200);
  assert.notEqual((await api(other,'/prekeys/status',{peer:peer.address})).status,200);
  assert.equal((await api(peer,'/prekeys/availability',{owner:owner.address})).value.available,4);
  assert.equal((await api(other,'/prekeys/availability',{owner:owner.address})).value.available,0);
  assert.equal((await api(peer,'/prekeys/availability',{owner:owner.address})).value.available,4); // no reservation by observation

  assert.notEqual((await api(other,'/prekeys/allocate',{owner:owner.address,reservation:randomUUID()})).status,200);
  const reservation=randomUUID(),results=await Promise.all(Array.from({length:4},()=>api(peer,'/prekeys/allocate',{owner:owner.address,reservation})));
  assert.ok(results.every(r=>r.status===200));assert.equal(new Set(results.map(r=>r.value.key.body.id)).size,1);
  const distinct=await Promise.all(Array.from({length:3},()=>api(peer,'/prekeys/allocate',{owner:owner.address,reservation:randomUUID()})));
  assert.equal(new Set([...results,...distinct].map(r=>r.value.key.body.id)).size,4);
  assert.equal((await api(peer,'/prekeys/availability',{owner:owner.address})).value.available,0);
});
