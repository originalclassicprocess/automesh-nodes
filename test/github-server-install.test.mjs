import test from 'node:test';
import assert from 'node:assert/strict';
import {settings,archiveNames} from '../scripts/github-server-install.mjs';
const env={SSH_USER:'example',SSH_HOST:'hosting.example',SSH_PORT:'21098',NODE_ORIGIN:'https://node.chat.example',APP_ORIGIN:'https://chat.example',NODE_ROOT:'/home/example/automesh-node-app',NODE_DOCUMENT_ROOT:'/home/example/node.chat.example',BOOTSTRAP_NODE:'/home/example/nodevenv/automesh-app/24/bin/node',INSTALL_RUN_ID:'123-1'};
test('first installer binds only a separate explicit node root and domain',()=>{
 const s=settings(env);assert.equal(s.root,env.NODE_ROOT);assert.deepEqual(s.allowedOrigins,[env.APP_ORIGIN]);
 for(const change of [{NODE_ROOT:'/home/example/automesh-app'},{NODE_DOCUMENT_ROOT:'/home/example/public_html'},{NODE_ORIGIN:env.APP_ORIGIN},{SSH_PORT:'0'},{BOOTSTRAP_NODE:'/usr/bin/node'},{INSTALL_RUN_ID:'../../outside'}])assert.throws(()=>settings({...env,...change}));
});
test('server package extraction rejects traversal, symlinks and special files',()=>{
 assert.doesNotThrow(()=>archiveNames('./\n./app.cjs\n','drwxr-xr-x dir\n-rw-r--r-- app.cjs\n'));
 for(const name of ['/tmp/out','./../out','./a/../../out','C:\\out'])assert.throws(()=>archiveNames(name+'\n','-rw-r--r-- file\n'));
 for(const t of ['l','h','b','p'])assert.throws(()=>archiveNames('./app.cjs\n',t+'rwxrwxrwx file\n'));
});
