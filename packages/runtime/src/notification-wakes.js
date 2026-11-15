import {readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,webcrypto} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {privateDirectory,writeAtomic} from './files.js';
import {accountIdFromPublicKey} from '../../protocol/src/account-id.js';

export const NOTIFICATION_WAKE_PROTOCOL='automesh-notification-wake-v1';
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.sort().join();
const token=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{22,86}$/.test(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const endpoint=origin=>{try{const u=new URL(origin);return u.protocol==='https:'&&u.origin===origin&&!u.username&&!u.password?origin+'/api/notifications':null;}catch{return null;}};
// Only the operator-approved application origins are allowed outbound. No
// caller-controlled URLs, DNS discovery, redirects or node-to-node forwarding.
export function forwardNotification(provider,input){
  const bytes=Buffer.from(JSON.stringify(input));
  return new Promise((resolve,reject)=>{
    const req=httpsRequest(provider+'/notify',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':bytes.length},signal:AbortSignal.timeout(8000)},res=>{
      res.resume();res.on('error',reject);res.on('end',()=>res.statusCode>=200&&res.statusCode<300?resolve():reject(Object.assign(Error('notification_rejected'),{statusCode:res.statusCode})));
    });req.on('error',reject);req.end(bytes);
  });
}
export class NotificationWakes{
  constructor(directory,{origins=[],now=Date.now,send=forwardNotification,permitted=()=>true}={}){
    this.directory=join(directory,'notification-wakes');this.providers=[...new Set(origins.map(endpoint).filter(Boolean))].slice(0,8);
    this.now=now;this.send=send;this.permitted=permitted;this.jobs=[];this.chain=Promise.resolve();this.running=null;this.stopped=false;
  }
  async initialize(){
    await privateDirectory(this.directory);
    try{const file=join(this.directory,'pending.json'),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('notification_store');
      const value=JSON.parse(await readFile(file,'utf8'));if(value.version!==1||!Array.isArray(value.jobs)||value.jobs.length>256)throw Error('notification_store');
      for(const job of value.jobs){if(!exact(job,['id','sender','to','provider','input','due','expires','attempts'])||!Number.isSafeInteger(job.due)||!Number.isSafeInteger(job.expires)||!Number.isInteger(job.attempts)||job.attempts<0||job.attempts>4||typeof job.id!=='string'||job.id!==hash(JSON.stringify([job.sender,job.to,job.provider,job.input.body.event]))||!await this.valid(job.sender,job.to,job.provider,job.input))continue;if(job.expires>this.now())this.jobs.push(job);}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    this.timer=setInterval(()=>{void this.flush().catch(()=>{});},15000);this.timer.unref?.();void this.flush().catch(()=>{});return this;
  }
  async valid(sender,to,provider,input){
    if(!this.providers.includes(provider)||!exact(input,['account','device','at','nonce','body','publicKey','signature'])||input.account!==sender||
      !token(input.device)||!token(input.nonce)||!Number.isSafeInteger(input.at)||Math.abs(input.at-this.now())>120000||
      !exact(input.body,['to','kind','event','returnRoute'])||input.body.to!==to||input.body.kind!=='message'||input.body.returnRoute!==null||!token(input.body.event)||
      typeof input.publicKey!=='string'||input.publicKey.length!==87||typeof input.signature!=='string'||input.signature.length!==86)return false;
    try{const pub=Buffer.from(input.publicKey,'base64url');if(await accountIdFromPublicKey(pub,webcrypto.subtle)!==sender)return false;
      const key=await webcrypto.subtle.importKey('raw',pub,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
      const data=new TextEncoder().encode(JSON.stringify(['automesh-notifications-v1',provider,'notify',input.account,input.device,input.at,input.nonce,input.body]));
      return await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(input.signature,'base64url'),data);
    }catch{return false;}
  }
  serial(work){const result=this.chain.then(work);this.chain=result.catch(()=>{});return result;}
  save(){return writeAtomic(this.directory,'pending.json',{version:1,jobs:this.jobs});}
  async add(sender,to,value){
    if(this.stopped||!exact(value,['protocol','requests'])||value.protocol!==NOTIFICATION_WAKE_PROTOCOL||!Array.isArray(value.requests)||value.requests.length>4)return false;
    for(const r of value.requests)if(!exact(r,['provider','input'])||!await this.valid(sender,to,r.provider,r.input))return false;
    return this.serial(async()=>{
      if(this.stopped)return false;const prior=this.jobs;const next=prior.filter(j=>j.expires>this.now());
      for(const r of value.requests){const id=hash(JSON.stringify([sender,to,r.provider,r.input.body.event]));if(next.some(j=>j.id===id))continue;if(next.length>=256)return false;next.push({id,sender,to,provider:r.provider,input:r.input,due:this.now(),expires:Math.min(this.now()+90000,r.input.at+110000),attempts:0});}
      this.jobs=next;try{await this.save();}catch(e){this.jobs=prior;throw e;}
      // Called while accepting a courier job, but HTTP work starts only after
      // persistence and outside the node's primary message-operation chain.
      queueMicrotask(()=>{void this.flush().catch(()=>{});});return true;
    });
  }
  flush(){if(this.running||this.stopped)return this.running??Promise.resolve();
    this.running=(async()=>{
      for(let n=0;n<8&&!this.stopped;n++){
        const job=await this.serial(async()=>this.jobs.find(j=>j.due<=this.now()&&j.expires>this.now()&&j.attempts<4));if(!job)break;
        let done=!this.permitted(job.sender);
        if(!done)try{await this.send(job.provider,job.input);done=true;}catch(e){done=[400,401,403,404,410].includes(e.statusCode);}
        await this.serial(async()=>{const prior=this.jobs;if(done)this.jobs=this.jobs.filter(j=>j.id!==job.id&&j.expires>this.now());else this.jobs=this.jobs.map(j=>j.id===job.id?{...j,attempts:j.attempts+1,due:this.now()+15000*2**j.attempts}:j).filter(j=>j.expires>this.now());try{await this.save();}catch(e){this.jobs=prior;throw e;}});
      }
    })().finally(()=>{this.running=null;});return this.running;
  }
  async close(){this.stopped=true;clearInterval(this.timer);await this.running;await this.chain;}
}
