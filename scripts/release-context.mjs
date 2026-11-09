import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..'),env=process.env;
const version=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).version;
if(!/^\d+\.\d+\.\d+$/.test(version)||env.RELEASE_VERSION!==version||env.GITHUB_REPOSITORY!=='originalclassicprocess/automesh-nodes'||
  env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_WORKFLOW_REF!=='originalclassicprocess/automesh-nodes/.github/workflows/release.yml@refs/heads/main'||
  !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')||env.GITHUB_EVENT_NAME!=='workflow_dispatch')throw Error('release_context_mismatch');
if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw Error('release_source_modified');
console.log(`Release context validated: v${version}, ${env.GITHUB_SHA}`);
