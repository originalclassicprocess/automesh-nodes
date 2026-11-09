// Runner-only operator. Download from this private repository using its job token;
// never send GitHub credentials to hosting or embed them in the public files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const e=process.env, tag=e.RELEASE_TAG, user=e.SSH_USER, host=e.SSH_HOST, port=e.SSH_PORT;
if (!/^v\d+\.\d+\.\d+$/.test(tag||'') || !/^[a-z][a-z0-9_-]{0,31}$/.test(user||'') ||
    !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(host||'') || !/^\d{1,5}$/.test(port||'') || +port<1 || +port>65535 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(e.APP_DIRECTORY||'') || !/^\d+-\d+$/.test(e.DEPLOY_RUN_ID||'') ||
    !/^[-\w]+\/[-\w.]+$/.test(e.GITHUB_REPOSITORY||'') || !e.GITHUB_TOKEN) throw Error('Invalid download deployment context');
const origin=new URL(e.DEPLOY_ORIGIN);
if(origin.protocol!=='https:' || origin.origin!==e.DEPLOY_ORIGIN || e.NODE_TLS_REJECT_UNAUTHORIZED==='0') throw Error('Canonical trusted HTTPS required');
const root=`/home/${user}/${e.APP_DIRECTORY}`, node=e.DEPLOY_NODE_BIN;
if(!node?.startsWith(`/home/${user}/`) || !/^\/[A-Za-z0-9_./-]+\/node$/.test(node) || node.split('/').some(p=>p==='.'||p==='..')) throw Error('Invalid hosting runtime');
const headers={Authorization:`Bearer ${e.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
async function metadata(path) {
  const response=await fetch(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/${path}`,{headers,signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw Error('GitHub metadata unavailable: '+response.status); return response.json();
}
const release=await metadata(`releases/tags/${tag}`),ref=await metadata(`git/ref/tags/${tag}`);
if(release.draft || release.tag_name!==tag || ref.object.type!=='commit' || release.target_commitish!==ref.object.sha) throw Error('Release source mismatch');
async function asset(name,limit) {
  const entry=release.assets.find(a=>a.name===name);
  if(!entry || entry.size<1 || entry.size>limit || !/^sha256:[a-f0-9]{64}$/.test(entry.digest||'')) throw Error('Missing GitHub asset digest: '+name);
  const response=await fetch(`https://api.github.com/repos/${e.GITHUB_REPOSITORY}/releases/assets/${entry.id}`,{headers:{...headers,Accept:'application/octet-stream'},signal:AbortSignal.timeout(240000)});
  if(!response.ok || !response.body) throw Error('Asset download failed');
  let size=0;const chunks=[];
  for await(const chunk of response.body) {size+=chunk.length;if(size>entry.size)throw Error('Asset exceeds declared size');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(size!==entry.size || 'sha256:'+createHash('sha256').update(bytes).digest('hex')!==entry.digest) throw Error('GitHub asset checksum mismatch');
  return bytes;
}
const manifestBytes=await asset('node-release.json',8192),manifest=JSON.parse(manifestBytes);
const installer=await asset('Automesh-Node-Setup.exe',256*1024*1024);
if(manifest.version!==tag.slice(1) || manifest.url!=='/downloads/Automesh-Node-Setup.exe' || manifest.bytes!==installer.length ||
   manifest.sha256!==createHash('sha256').update(installer).digest('hex') || typeof manifest.signed!=='boolean') throw Error('Manifest mismatch');
const local=mkdtempSync(join(tmpdir(),'automesh-windows-download-')),created=[];
const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
try {
  if(!e.SSH_PRIVATE_KEY?.includes('PRIVATE KEY-----') || !e.SSH_KNOWN_HOSTS?.trim())throw Error('Hosting credentials missing');
  for(const [name,bytes] of [['key',e.SSH_PRIVATE_KEY.trim()+'\n'],['hosts',e.SSH_KNOWN_HOSTS.trim()+'\n'],['node-release.json',manifestBytes],['Automesh-Node-Setup.exe',installer]]) {
    const path=join(local,name);writeFileSync(path,bytes,{flag:'wx',mode:0o600});created.push(path);
  }
  const options=['-i',join(local,'key'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${join(local,'hosts')}`,'-o','ConnectTimeout=10','-o','ForwardAgent=no','-o','ClearAllForwardings=yes'];
  const run=(cmd,args)=>execFileSync(cmd,args,{stdio:'inherit',timeout:600000,env:{...e,GITHUB_TOKEN:'',SSH_PRIVATE_KEY:'',SSH_KNOWN_HOSTS:''}});
  const target=`${user}@${host}`, stage=`${root}/.deploy-tools/windows-${e.DEPLOY_RUN_ID}`;
  const ssh=command=>run('ssh',['-T','-p',port,...options,target,command]);
  ssh(`test -d ${q(root)} && test ! -L ${q(root)} && umask 077 && mkdir -p ${q(root+'/.deploy-tools')} && test ! -L ${q(root+'/.deploy-tools')} && mkdir ${q(stage)}`);
  for(const file of ['node-release.json','Automesh-Node-Setup.exe'])run('scp',['-P',port,...options,join(local,file),`${target}:${stage}/${file}`]);
  run('scp',['-P',port,...options,resolve('scripts/windows-downloads-operator.mjs'),`${target}:${stage}/operator.mjs`]);
  run('scp',['-P',port,...options,resolve('scripts/hosting-app-transaction.mjs'),`${target}:${stage}/deployment.mjs`]);
  ssh([node,stage+'/operator.mjs',root,e.DEPLOY_ORIGIN,stage,tag.slice(1),manifest.sha256].map(q).join(' '));
} finally { for(const path of created)unlinkSync(path);rmdirSync(local); }
