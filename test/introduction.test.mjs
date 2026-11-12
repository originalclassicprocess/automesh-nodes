import {test} from 'node:test';
import assert from 'node:assert/strict';
import {INTRODUCTION_PROTOCOL,INTRODUCTION_MAX_BYTES,validIntroductionFrame} from '../packages/protocol/src/introduction.js';

test('online introduction frames are versioned, bounded and distinct from ordinary signaling',()=>{
  const frame={protocol:INTRODUCTION_PROTOCOL,kind:'open'};
  assert.equal(validIntroductionFrame(frame),true);
  assert.equal(validIntroductionFrame({...frame,kind:'frame',frame:Buffer.alloc(INTRODUCTION_MAX_BYTES).toString('base64')}),true);
  for(const invalid of [null,{}, {...frame,protocol:'other'}, {...frame,kind:'file'}, {...frame,frame:'AAAA'},
    {...frame,kind:'frame',frame:'!'}, {...frame,kind:'frame',frame:Buffer.alloc(INTRODUCTION_MAX_BYTES+1).toString('base64')}])
    assert.equal(validIntroductionFrame(invalid),false);
});
