import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createNodeService } from '../packages/runtime/src/index.js';
import { protector } from './fixtures.mjs';

test('WebKit cache preflight accepts the approved app but never authorizes another site', async () => {
  const directory=await mkdtemp(join(tmpdir(),'automesh-browser-cors-'));
  const origin='https://current-app.invalid', hosts=['127.0.0.1:0'];
  let service;
  try {
    service=await createNodeService({directory,hosts,origins:[origin],adminToken:'a'.repeat(64),secretProtector:protector(),testHttp:true});
    const server=service.createPublicServer(); server.listen(0,'127.0.0.1'); await once(server,'listening');
    hosts.push('127.0.0.1:'+server.address().port); const base='http://'+hosts[1];
    for (const [path,method,headers] of [['/node/info','GET','cache-control,pragma'],['/node/challenge','POST','content-type,cache-control,pragma'],['/mailbox/status','POST','content-type,x-automesh-proof,cache-control,pragma']]) {
      const response=await fetch(base+path,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':headers}});
      assert.equal(response.status,204); assert.equal(response.headers.get('access-control-allow-origin'),origin);
      const allowed=response.headers.get('access-control-allow-headers').toLowerCase().split(',').map(s=>s.trim());
      for (const header of headers.split(',')) assert.ok(allowed.includes(header),header);
    }
    const denied=await fetch(base+'/node/info',{method:'OPTIONS',headers:{Origin:'https://unapproved.invalid','Access-Control-Request-Method':'GET'}});
    assert.equal(denied.status,403); assert.equal(denied.headers.get('access-control-allow-origin'),null);
    assert.equal((await (await fetch(base+'/node/info',{headers:{Origin:origin}})).json()).protocol,'automesh-node-v1');
    assert.equal((await fetch(base+'/mailbox/status',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
  } finally { if(service) await service.close(); await rm(directory,{recursive:true,force:true}); }
});
