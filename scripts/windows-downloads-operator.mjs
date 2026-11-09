// Hosting-side operator, outside the served tree. Reuse the already installed
// app deployment transaction, backup and rollback; the app version stays fixed.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, copyFileSync, unlinkSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
const [root,origin,stage,version,digest]=process.argv.slice(2);
const within=(parent,path)=>{const child=relative(parent,path);if(!child||child.startsWith('..')||isAbsolute(child))throw Error('Path outside expected root');};
const regular=(path,dir=false)=>{const s=lstatSync(path);if(s.isSymbolicLink()||!(dir?s.isDirectory():s.isFile()))throw Error('Unexpected deployment file');};
within(homedir(),root);within(join(root,'.deploy-tools'),stage);
if(root!==resolve(root)||stage!==resolve(stage)||!/^\d+\.\d+\.\d+$/.test(version)||!/^[a-f0-9]{64}$/.test(digest))throw Error('Invalid deployment request');
for(let path=root;path!==homedir();path=dirname(path))regular(path,true);
for(let path=stage;path!==root;path=dirname(path))regular(path,true);
regular(join(stage,'deployment.mjs'));
const {validateRelease,releaseVersion,updateApplication,selectorLifecycle,liveProbe}=await import(pathToFileURL(join(stage,'deployment.mjs')).href);
const live=JSON.parse(readFileSync(join(root,'release-manifest.json'),'utf8')),appVersion=releaseVersion(root),sha=b=>createHash('sha256').update(b).digest('hex');
if(live.version!==appVersion||!Array.isArray(live.files)||!live.files.length||live.files.length>10000)throw Error('Invalid live release manifest');
const incoming=join(root,'.deploy-incoming');try{mkdirSync(incoming,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}regular(incoming,true);
const candidate=join(incoming,'automesh-windows-'+randomUUID());mkdirSync(candidate,{mode:0o700});
const paths=new Set();
for(const file of live.files) {
  if(typeof file.path!=='string'||!/^[A-Za-z0-9_.\/-]+$/.test(file.path)||file.path.split('/').some(p=>!p||p==='.'||p==='..')||paths.has(file.path))throw Error('Invalid live release entry');
  within(root,resolve(root,file.path));within(candidate,resolve(candidate,file.path));
  const src=join(root,file.path),dst=join(candidate,file.path);
  for(let path=dirname(src);path!==root;path=dirname(path))regular(path,true);
  regular(src);if(sha(readFileSync(src))!==file.sha256)throw Error('Live release checksum mismatch');
  mkdirSync(dirname(dst),{recursive:true});copyFileSync(src,dst);paths.add(file.path);
}
const manifest=JSON.parse(readFileSync(join(stage,'node-release.json'),'utf8')),installer=readFileSync(join(stage,'Automesh-Node-Setup.exe'));
if(manifest.version!==version||manifest.sha256!==digest||sha(installer)!==digest||manifest.bytes!==installer.length||manifest.url!=='/downloads/Automesh-Node-Setup.exe')throw Error('Staged download mismatch');
const changed=['build/client/downloads/Automesh-Node-Setup.exe','build/client/downloads/node-release.json'];
const previousDigest=sha(readFileSync(join(root,changed[0])));
for(const [i,file]of changed.entries()) {
  mkdirSync(dirname(join(candidate,file)),{recursive:true});copyFileSync(join(stage,i?'node-release.json':'Automesh-Node-Setup.exe'),join(candidate,file));paths.add(file);
  // Stale precompressed files must not shadow the new bytes.
  for(const ext of ['.gz','.br'])if(paths.has(file+ext)){unlinkSync(join(candidate,file+ext));paths.delete(file+ext);}
}
writeFileSync(join(candidate,'release-manifest.json'),JSON.stringify({...live,files:[...paths].sort().map(path=>({path,sha256:sha(readFileSync(join(candidate,path)))}))},null,2)+'\n',{flag:'wx',mode:0o600});
validateRelease(candidate);
const appProbe=liveProbe(root,origin);
let probes=0;
const result=await updateApplication({root,candidate,lifecycle:selectorLifecycle(root),probe:async actual=>{
  probes++;
  await appProbe(actual);
  const installedDigest=sha(readFileSync(join(root,changed[0])));
  if(probes>1 && actual===appVersion && installedDigest===previousDigest) return; // verified rollback
  if(actual!==appVersion||installedDigest!==digest)throw Error('Unexpected live package or app version');
  const url=new URL('/downloads/node-release.json',origin);url.searchParams.set('node',version);
  const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!response.ok || (await response.json()).sha256!==digest)throw Error('Published manifest mismatch');
  const file=await fetch(new URL('/downloads/Automesh-Node-Setup.exe?node='+version,origin),{cache:'no-store',signal:AbortSignal.timeout(90000)});
  if(!file.ok||sha(Buffer.from(await file.arrayBuffer()))!==digest)throw Error('Published installer mismatch');
}});
console.log(JSON.stringify({windowsNode:version,appVersionUnchanged:result.version===appVersion,sha256:digest,backup:result.backup,verified:true}));
