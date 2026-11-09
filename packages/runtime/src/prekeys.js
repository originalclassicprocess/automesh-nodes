import {readFile,readdir,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {privateDirectory,writeAtomic,removeAtomic} from './files.js';
import {verifyCourierSignature} from './courier.js';
import {COURIER_TTL,courierId} from '../../protocol/src/courier-protocol.js';
import {COURIER_PREKEY_PROTOCOL,PREKEY_TARGET,MAX_DIRECTORY_KEYS,validatePrekey} from '../../protocol/src/courier-prekeys.js';
import {isValidAccountId} from '../../protocol/src/bech32m.js';
import {validateCourierRoute} from '../../protocol/src/courier-route.js';

// Public certificates only. Claims are durable before a key leaves the node.
// All operations run on the application's existing serialized storage actor.
export class CourierPrekeys {
  constructor(directory,{nodeId,isMember,now=Date.now,maxBytes=8*1024*1024,write=writeAtomic}){
    this.directory=directory;this.nodeId=nodeId;this.isMember=isMember;this.now=now;this.maxBytes=maxBytes;this.records=new Map();this.write=write;
  }
  name(owner,peer){return createHash('sha256').update(owner+':'+peer).digest('hex')+'.json';}
  size(record){return Buffer.byteLength(JSON.stringify(record));}
  stats(){return {bytes:[...this.records.values()].reduce((n,r)=>n+this.size(r),0)};}
  summary(owner){return [...this.records.values()].filter(r=>r.owner===owner&&!r.revoked).map(r=>({peer:r.peer,
    available:r.entries.filter(e=>!e.reservation&&e.key.body.acceptUntil>this.now()+3600000).length}));}
  live(entry){return entry.reservation?entry.expiresAt>this.now():entry.key.body.acceptUntil>this.now();}
  async initialize(){
    await privateDirectory(this.directory);const names=await readdir(this.directory);
    if(names.length>800)throw Error('prekey_disk_limit');
    let loaded=0;
    for(const name of names){
      if(/^\.pending-[a-f0-9]{32}$/.test(name)){await unlink(join(this.directory,name));continue;}
      if(!/^[a-f0-9]{64}\.json$/.test(name))throw Error('corrupt_prekey_directory');
      const info=await lstat(join(this.directory,name));loaded+=info.size;if(!info.isFile()||info.isSymbolicLink()||info.size>this.maxBytes||loaded>this.maxBytes)throw Error('corrupt_prekey_directory');
      const record=JSON.parse(await readFile(join(this.directory,name),'utf8'));
      if(record.version!==1||!isValidAccountId(record.owner)||!isValidAccountId(record.peer)||name!==this.name(record.owner,record.peer)||
        (record.revoked!==undefined&&record.revoked!==true)||!Array.isArray(record.entries)||record.entries.length>MAX_DIRECTORY_KEYS||new Set(record.entries.map(e=>e.key?.body?.id)).size!==record.entries.length)throw Error('corrupt_prekey_directory');
      const reservations=new Set();
      if(record.route){validateCourierRoute(record.route,record.owner,record.peer,record.route.body?.issuedAt);await verifyCourierSignature(record.route,'route',record.owner);}
      for(const entry of record.entries){
        // Validate expired persisted certificates at issuance, before sweeping.
        const b=entry.key?.body;validatePrekey(entry.key,record.owner,record.peer,b?.issuedAt);
        if(b.node.nodeId!==this.nodeId)throw Error('corrupt_prekey_directory');
        await verifyCourierSignature(entry.key,'prekey',record.owner);
        if(entry.reservation!==undefined){
          if(!courierId(entry.reservation)||reservations.has(entry.reservation)||!Number.isSafeInteger(entry.allocatedAt)||
            entry.allocatedAt<0||entry.allocatedAt<b.issuedAt-300000||entry.allocatedAt>b.acceptUntil||entry.expiresAt!==entry.allocatedAt+COURIER_TTL||entry.expiresAt>b.retainUntil)throw Error('corrupt_prekey_directory');
          reservations.add(entry.reservation);
        }else if(Object.keys(entry).join(',')!=='key')throw Error('corrupt_prekey_directory');
      }
      this.records.set(name,record);
    }
    await this.sweep();if(this.stats().bytes>this.maxBytes)throw Error('prekey_disk_limit');return this;
  }
  async save(record){
    if(this.failed)throw Error('prekey_unavailable');
    const name=this.name(record.owner,record.peer),old=this.records.get(name);
    if(this.stats().bytes-(old?this.size(old):0)+this.size(record)>this.maxBytes||record.entries.length>MAX_DIRECTORY_KEYS||
      [...this.records.values()].filter(r=>r.owner===record.owner).reduce((n,r)=>n+(r===old?0:r.entries.length),0)+record.entries.length>MAX_DIRECTORY_KEYS)throw Error('prekey_capacity');
    try{await this.write(this.directory,name,record);}catch(error){this.failed=true;throw error;}this.records.set(name,record);
  }
  async sweep(){if(this.failed)throw Error('prekey_unavailable');for(const [name,record] of this.records){const entries=record.entries.filter(e=>this.live(e));
    if(!entries.length||!this.isMember(record.owner)){await removeAtomic(this.directory,name);this.records.delete(name);}
    else if(entries.length!==record.entries.length)await this.save({...record,entries});
  }}
  async removeOwner(owner){for(const [name,r] of this.records)if(r.owner===owner){await removeAtomic(this.directory,name);this.records.delete(name);}}
  async revoke(owner,peer){
    if(!this.isMember(owner)||!isValidAccountId(peer))throw Error('prekey_denied');
    const record=this.records.get(this.name(owner,peer));
    if(record)await this.save({...record,revoked:true,entries:record.entries.filter(e=>e.reservation&&this.live(e))});
    return {protocol:COURIER_PREKEY_PROTOCOL,revoked:true};
  }
  async status(owner,peer){
    if(!this.isMember(owner)||!isValidAccountId(peer)||owner===peer)throw Error('prekey_denied');await this.sweep();
    const record=this.records.get(this.name(owner,peer)),entries=record?.entries??[],available=entries.filter(e=>!e.reservation);
    const ownerCount=[...this.records.values()].filter(r=>r.owner===owner).reduce((n,r)=>n+r.entries.length,0);
    const reusableBytes=available.reduce((n,e)=>n+this.size(e),0);
    const capacity=Math.max(0,Math.min(PREKEY_TARGET,MAX_DIRECTORY_KEYS-entries.length+available.length,MAX_DIRECTORY_KEYS-ownerCount+available.length,
      Math.floor((this.maxBytes-this.stats().bytes+reusableBytes-2048)/2048)));
    return {protocol:COURIER_PREKEY_PROTOCOL,capacity,
      known:(record?.entries??[]).map(e=>e.key.body.id),
      available:available.map(e=>e.key.body.id)};
  }
  async publish(owner,{peer,keys,keep,route}){
    if(!this.isMember(owner)||!isValidAccountId(peer)||owner===peer||!Array.isArray(keys)||keys.length>PREKEY_TARGET||
      !Array.isArray(keep)||keep.length>PREKEY_TARGET||keep.some(id=>!/^[a-f0-9]{32}$/.test(id))||new Set(keep).size!==keep.length)throw Error('invalid_prekey_request');
    for(const key of keys){validatePrekey(key,owner,peer,this.now());if(key.body.node.nodeId!==this.nodeId)throw Error('prekey_denied');await verifyCourierSignature(key,'prekey',owner);}
    if(route){validateCourierRoute(route,owner,peer,this.now());await verifyCourierSignature(route,'route',owner);}
    await this.sweep();const name=this.name(owner,peer),old=this.records.get(name);
    if(!old&&[...this.records.values()].filter(r=>r.owner===owner).length>=50)throw Error('prekey_capacity');
    const next=structuredClone(old??{version:1,owner,peer,entries:[]});
    delete next.revoked;
    if(route&&(!next.route||route.body.issuedAt>next.route.body.issuedAt))next.route=route;
    // A restored backup may lack newer private keys. Remove only unallocated
    // public keys absent from that device; never reissue already claimed keys.
    next.entries=next.entries.filter(e=>e.reservation||keep.includes(e.key.body.id));
    for(const key of keys){const existing=next.entries.find(e=>e.key.body.id===key.body.id);
      if(existing){if(JSON.stringify(existing.key.body)!==JSON.stringify(key.body)||existing.key.publicKey!==key.publicKey)throw Error('prekey_conflict');}
      else next.entries.push({key});
    }
    if(next.entries.filter(e=>!e.reservation).length>PREKEY_TARGET)throw Error('prekey_capacity');
    await this.save(next);return this.status(owner,peer);
  }
  async availability(peer,value) {
    const owner=value?.owner;
    if(!this.isMember(owner)||!isValidAccountId(peer)||owner===peer)throw Error('prekey_denied');
    await this.sweep();const record=this.records.get(this.name(owner,peer));
    // Only this authenticated correspondent's stock; no key is reserved here.
    return {protocol:COURIER_PREKEY_PROTOCOL,available:record&&!record.revoked?record.entries.filter(e=>!e.reservation).length:0};
  }
  async allocate(peer,{owner,reservation}){
    if(!this.isMember(owner)||!isValidAccountId(peer)||owner===peer||!courierId(reservation))throw Error('prekey_denied');
    await this.sweep();const record=this.records.get(this.name(owner,peer));if(!record||record.revoked)throw Error('prekeys_unavailable');
    let entry=record.entries.find(e=>e.reservation===reservation);
    if(!entry){
      const next=structuredClone(record);entry=next.entries.find(e=>!e.reservation);if(!entry)throw Error('prekeys_unavailable');
      entry.reservation=reservation;entry.allocatedAt=this.now();entry.expiresAt=entry.allocatedAt+COURIER_TTL;
      await this.save(next);
    }
    return {protocol:COURIER_PREKEY_PROTOCOL,reservation,key:entry.key,allocatedAt:entry.allocatedAt,expiresAt:entry.expiresAt,
      ...(record.route?.body.expiresAt>this.now()?{route:record.route}:{})};
  }
}
