import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameCommitted } from '../packages/runtime/src/files.js';
test('Windows retries a transient rename against the exact same paths without early success',async()=>{
  let attempts=0; const waits=[],paths=[];
  await renameCommitted('source','destination',{platform:'win32',move:async(...args)=>{paths.push(args);if(++attempts<3)throw Object.assign(new Error('locked'),{code:'EPERM'});},wait:async ms=>waits.push(ms)});
  assert.equal(attempts,3);assert.deepEqual(waits,[10,25]);assert.deepEqual(paths,Array(3).fill(['source','destination']));
});
test('a permanent Windows lock has a bounded budget and still rejects the commit',async()=>{
  let attempts=0;const waits=[],failure=Object.assign(new Error('locked'),{code:'EACCES'});
  await assert.rejects(renameCommitted('source','destination',{platform:'win32',move:async()=>{attempts++;throw failure;},wait:async ms=>waits.push(ms)}),error=>error===failure);
  assert.equal(attempts,7);assert.equal(waits.reduce((a,b)=>a+b,0),785);
});
test('POSIX permission errors are not disguised as transient Windows locks',async()=>{
  let attempts=0;await assert.rejects(renameCommitted('source','destination',{platform:'linux',move:async()=>{attempts++;throw Object.assign(new Error('denied'),{code:'EPERM'});},wait:async()=>assert.fail('must not wait')}),/denied/);assert.equal(attempts,1);
});
test('unexpected Windows filesystem errors are not retried',async()=>{
  let attempts=0;await assert.rejects(renameCommitted('source','destination',{platform:'win32',move:async()=>{attempts++;throw Object.assign(new Error('missing'),{code:'ENOENT'});},wait:async()=>assert.fail('must not wait')}),/missing/);assert.equal(attempts,1);
});
