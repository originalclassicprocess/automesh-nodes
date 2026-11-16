import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{webcrypto,randomBytes}from'node:crypto';
import{NotificationWakes,NOTIFICATION_WAKE_PROTOCOL}from'../packages/runtime/src/notification-wakes.js';
import{createHomeNode}from'../packages/runtime/src/application.js';import{identity,protector}from'./fixtures.mjs';
import{once}from'node:events';import{createHash}from'node:crypto';
const provider='https://automesh.online/api/notifications',token=()=>randomBytes(32).toString('base64url');
test('home role advertises the same persisted wake capability as the server role',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automesh-home-wakes-')),hosts=['127.0.0.1:0'];let node;
 try{node=await createHomeNode({directory:dir,hosts,origins:['https://automesh.online'],adminToken:'a'.repeat(64),testHttp:true,localRouteScope:'lan',secretProtector:protector()});const server=node.createPublicServer();server.listen(0,'127.0.0.1');await once(server,'listening');const host=`127.0.0.1:${server.address().port}`;hosts.push(host);
 const response=await fetch(`http://${host}/node/info`),info=await response.json();assert.equal(response.status,200);assert.equal(info.role,'home');assert.equal(info.notificationRelay.protocol,NOTIFICATION_WAKE_PROTOCOL);assert.ok(info.notificationRelay.providers.includes(provider));
 }finally{await node?.close();await rm(dir,{recursive:true,force:true});}
});
async function wake(from,to,overrides={}){const input={account:from.address,device:token(),at:Date.now(),nonce:token(),body:{to:to.address,kind:'message',event:token(),returnRoute:null},publicKey:Buffer.from(from.publicKey,'hex').toString('base64url'),signature:'',...overrides};const bytes=new TextEncoder().encode(JSON.stringify(['automesh-notifications-v1',provider,'notify',input.account,input.device,input.at,input.nonce,input.body]));input.signature=Buffer.from(await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},from.keys.privateKey,bytes)).toString('base64url');return{protocol:NOTIFICATION_WAKE_PROTOCOL,requests:[{provider,input}]};}
test('server node forwards only the signed wake for the stored job author/recipient, without message content',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automesh-wakes-')),from=await identity(),to=await identity(),sent=[];const queue=await new NotificationWakes(dir,{origins:['https://automesh.online'],send:async(p,input)=>sent.push({p,input})}).initialize();
 try{const value=await wake(from,to);assert.equal(await queue.add(from.address,to.address,value),true);await queue.flush();assert.equal(sent.length,1);assert.equal(sent[0].input.body.returnRoute,null);assert.equal(sent[0].input.body.to,to.address);
  const other=await identity();assert.equal(await queue.add(other.address,to.address,value),false);assert.equal(await queue.add(from.address,other.address,value),false);
  assert.equal(await queue.add(from.address,to.address,{...value,requests:[{...value.requests[0],provider:'https://127.0.0.1/api/notifications'}]}),false);
  const reverse=await wake(from,to,{body:{to:to.address,kind:'return',event:token(),returnRoute:null}});assert.equal(await queue.add(from.address,to.address,reverse),false);
 }finally{await queue.close();await rm(dir,{recursive:true,force:true});}
});
test('wake retry survives node restart, expires quickly and does not need an open sender',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automesh-wakes-')),from=await identity(),to=await identity();let now=Date.now(),attempts=0;
 let queue=await new NotificationWakes(dir,{origins:['https://automesh.online'],now:()=>now,send:async()=>{attempts++;throw Error('outage');}}).initialize();
 try{await queue.add(from.address,to.address,await wake(from,to));await queue.flush();assert.equal(attempts,1);await queue.close();now+=20000;
  queue=await new NotificationWakes(dir,{origins:['https://automesh.online'],now:()=>now,send:async()=>{attempts++;}}).initialize();await queue.flush();assert.equal(attempts,2);assert.equal(queue.jobs.length,0);
 }finally{await queue.close();await rm(dir,{recursive:true,force:true});}
});
test('revoked membership cancels queued wake work',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automesh-wakes-')),from=await identity(),to=await identity();let calls=0;const queue=await new NotificationWakes(dir,{origins:['https://automesh.online'],permitted:()=>false,send:async()=>calls++}).initialize();
 try{await queue.add(from.address,to.address,await wake(from,to));await queue.flush();assert.equal(calls,0);assert.equal(queue.jobs.length,0);}finally{await queue.close();await rm(dir,{recursive:true,force:true});}
});
test('cancel removes a retry durably without disturbing other queued notifications',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automesh-wakes-')),from=await identity(),to=await identity();let queue,now=Date.now(),sent=[];
 const event=createHash('sha256').update(`automesh-notifications-v1:${from.address}:${to.address}:canceled-file`).digest('base64url');
 try{
  queue=await new NotificationWakes(dir,{origins:['https://automesh.online'],now:()=>now,send:async()=>{throw Error('outage');}}).initialize();
  await queue.add(from.address,to.address,await wake(from,to,{body:{to:to.address,kind:'message',event,returnRoute:null}}));await queue.flush();
  await queue.cancel(from.address,to.address,'canceled-file');assert.equal(queue.jobs.length,0);await queue.close();now+=20000;
  queue=await new NotificationWakes(dir,{origins:['https://automesh.online'],now:()=>now,send:async(p,input)=>sent.push(input)}).initialize();
  await queue.flush();assert.equal(sent.length,0);assert.equal(queue.jobs.length,0);
 }finally{await queue?.close();await rm(dir,{recursive:true,force:true});}
});
test('damaged optional wake storage does not prevent node startup or existing queues',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'automesh-wakes-'));await mkdir(join(dir,'notification-wakes'));await writeFile(join(dir,'notification-wakes/pending.json'),'broken');
 let node;try{node=await createHomeNode({directory:dir,hosts:['127.0.0.1:0'],origins:['https://automesh.online'],adminToken:'a'.repeat(64),testHttp:true,localRouteScope:'internet',secretProtector:protector()});assert.ok(node.courier);assert.equal(node.mailboxes.stats().messages,0);}finally{await node?.close();await rm(dir,{recursive:true,force:true});}
});
