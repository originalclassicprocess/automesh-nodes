import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DiskMailbox,Courier} from '../packages/runtime/src/index.js';
import {randomBytes,createHash} from 'node:crypto';
import {ATTACHMENT_PROTOCOL,ATTACHMENT_CHUNK_BYTES} from '../packages/protocol/src/index.js';
import {identity,protector,envelope,job} from './fixtures.mjs';
const roots=[],services=[];
async function directory(){const p=await mkdtemp(join(tmpdir(),'automesh-queue-lifecycle-'));roots.push(p);return p;}
afterEach(async()=>{for(const c of services.splice(0))await c.close();for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
test('expiry removes ciphertext but persists owner-only outcome across restart',async()=>{
 let now=Date.now();const path=await directory(),options={now:()=>now,retainOutcomes:true};
 let box=await new DiskMailbox(path,options).initialize();const e=envelope(now);await box.put('alice',e);
 now=e.expiresAt+1;await box.sweep();assert.equal(box.stats().messages,0);
 assert.equal((await box.outcomes('alice',[e.id]))[0].status,'expired');assert.deepEqual(await box.outcomes('bob',[e.id]),[]);
 assert.doesNotMatch(await readFile(join(path,e.id+'.json'),'utf8'),/ciphertext/);
 box=await new DiskMailbox(path,options).initialize();assert.equal((await box.outcomes('alice',[e.id]))[0].status,'expired');
 now+=31*86400000;await box.sweep();assert.equal(box.records.size,0);
});
test('cancellation tombstone prevents a late upload, is idempotent, and preserves actual delivery',async()=>{
 const box=await new DiskMailbox(await directory(),{retainOutcomes:true}).initialize(),e=envelope();
 assert.equal((await box.cancel('alice',e)).status,'canceled');assert.equal((await box.put('alice',e)).status,'canceled');
 assert.equal((await box.cancel('alice',e)).status,'canceled');assert.equal(box.stats().messages,0);
 await assert.rejects(box.cancel('bob',e),/message_conflict/);
 const other=envelope();await box.put('alice',other);await box.acknowledge([other.id],{[other.id]:'signed-receipt'});
 assert.equal((await box.cancel('alice',other)).status,'acknowledged');assert.equal((await box.receipts('alice',[other.id]))[0].receipt,'signed-receipt');
});
test('courier requires the author signature for cancellation and never requeues a canceled job',async()=>{
 const c=await new Courier(await directory(),{maxBytes:64*1024*1024,secretProtector:protector(),localInternetEnabled:true}).initialize();services.push(c);
 const [alice,bob,mallory]=await Promise.all([identity(),identity(),identity()]),j=await job(c.address,alice,bob);
 await c.put(alice.address,j);assert.equal(c.stats(alice.address).messages,1);
 await assert.rejects(c.cancel(mallory.address,j),/invalid_courier_author/);
 await assert.rejects(c.cancel(alice.address,{...j,signature:'a'.repeat(128)}),/invalid_courier_signature/);
 assert.equal((await c.cancel(alice.address,j)).status,'canceled');assert.equal(c.stats(alice.address).messages,0);
 assert.equal((await c.put(alice.address,j)).status,'canceled');assert.equal((await c.inbox(bob.address,{},'internet')).deliveries.length,0);
});

test('canceling a committed file frees bytes and file slots without recalling unrelated jobs',async()=>{
 const c=await new Courier(await directory(),{maxBytes:64*1024*1024,secretProtector:protector(),localInternetEnabled:true}).initialize();services.push(c);
 const [alice,bob]=await Promise.all([identity(),identity()]),part=randomBytes(48);
 const attachment={protocol:ATTACHMENT_PROTOCOL,id:randomBytes(16).toString('hex'),size:32,chunkBytes:ATTACHMENT_CHUNK_BYTES,chunks:1,bytes:48,digest:createHash('sha256').update(part).digest('hex')};
 const j=await job(c.address,alice,bob,attachment),other=await job(c.address,alice,bob);
 await c.startFile(alice.address,j);await c.attachments.put(alice.address,attachment.id,0,part.toString('base64url'));await c.put(alice.address,j);await c.put(alice.address,other);
 assert.equal(c.stats(alice.address).attachments.files,1);await c.cancel(alice.address,j);
 assert.equal(c.stats(alice.address).attachments.files,0);assert.equal(c.stats(alice.address).attachments.bytes,0);assert.equal(c.stats(alice.address).messages,1);
 assert.equal((await c.startFile(alice.address,j)).status,'canceled');assert.equal(c.stats(alice.address).attachments.files,0);
});

test('owner-only inventory pages stored jobs without consuming or exposing another profile',async()=>{
 const c=await new Courier(await directory(),{maxBytes:64*1024*1024,secretProtector:protector(),localInternetEnabled:true}).initialize();services.push(c);
 const [alice,bob]=await Promise.all([identity(),identity()]);
 for(let i=0;i<11;i++)await c.put(alice.address,await job(c.address,alice,bob));
 await c.put(bob.address,await job(c.address,bob,alice));
 const page=await c.outbox(alice.address,{});assert.equal(page.jobs.length,8);assert.ok(page.cursor);
 const tail=await c.outbox(alice.address,{cursor:page.cursor});assert.equal(tail.jobs.length,3);assert.equal(tail.cursor,'');
 assert.equal(new Set([...page.jobs,...tail.jobs].map(j=>j.body.id)).size,11);
 assert.equal(c.stats(alice.address).messages,11);assert.equal((await c.outbox(bob.address,{})).jobs.length,1);
 await c.cancel(alice.address,page.jobs[0]);assert.equal((await c.outbox(alice.address,{})).jobs.some(j=>j.body.id===page.jobs[0].body.id),false);
 await assert.rejects(c.outbox(alice.address,{cursor:'unbounded'}),/invalid_courier_job/);
});
