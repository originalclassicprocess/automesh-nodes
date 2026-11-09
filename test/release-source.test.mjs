import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('release publishers cannot execute contributor events or bypass attestation verification',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/release.yml',import.meta.url),'utf8');
  assert.ok(workflow.includes('workflow_dispatch:'));
  assert.ok(!/pull_request_target|workflow_run|secrets\./.test(workflow));
  assert.ok(workflow.includes("github.ref == 'refs/heads/main' && github.repository == 'originalclassicprocess/automesh-nodes'"));
  assert.ok(workflow.includes('--source-digest "$GITHUB_SHA" --signer-digest "$GITHUB_SHA"'));
  assert.ok(workflow.includes('--deny-self-hosted-runners'));
  assert.ok(workflow.indexOf('gh attestation verify')<workflow.indexOf('gh release create'));
  assert.ok(workflow.includes('refusing overwrite'));
  for(const match of workflow.matchAll(/uses: (\S+)/g))assert.match(match[1],/^actions\/[^@]+@[a-f0-9]{40}$/);
});
