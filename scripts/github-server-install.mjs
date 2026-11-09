// Runner-side, manual GitHub-only first installation. Never overwrites node data.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NODE_PROTOCOL} from '../packages/protocol/src/protocol.js';

export function settings(env){
 const user=env.SSH_USER,host=env.SSH_HOST,port=env.SSH_PORT;
 if(!/^[a-z][a-z0-9_-]{0,31}$/.test(user||'')||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host||'')||!/^\d{1,5}$/.test(port||'')||Number(port)<1||Number(port)>65535)throw Error('invalid_ssh_target');
 const origin=s=>{const u=new URL(s);if(u.protocol!=='https:'||u.origin!==s||u.username||u.password||u.port||!/^[-a-z0-9.]+$/i.test(u.hostname))throw Error('canonical_https_origin_required');return u;};
 const node=origin(env.NODE_ORIGIN),app=origin(env.APP_ORIGIN),peer=env.PEER_ORIGIN?origin(env.PEER_ORIGIN):null;
 if(node.hostname===app.hostname)throw Error('node_requires_separate_domain');
 const home='/home/'+user,root=home+'/automesh-node-app',documentRoot=home+'/'+node.hostname;
 if(env.NODE_ROOT!==root||env.NODE_DOCUMENT_ROOT!==documentRoot||!new RegExp('^/home/'+user+'/nodevenv/[a-z0-9-]+/24/bin/node$').test(env.BOOTSTRAP_NODE||''))throw Error('unexpected_install_target');
 if(!/^\d+-\d+$/.test(env.INSTALL_RUN_ID||''))throw Error('invalid_install_run_id');
 return {user,host,port,home,root,documentRoot,publicUrl:node.origin,allowedOrigins:[...new Set([app.origin,...(peer?[peer.origin]:[])])],bootstrapNode:env.BOOTSTRAP_NODE,stage:home+'/.automesh-node-install/'+env.INSTALL_RUN_ID};
}
export function archiveNames(names,types){
 for(let p of names.trim().split(/\r?\n/)){if(p==='./')continue;p=p.replace(/^\.\//,'').replace(/\/$/,'');if(!/^[A-Za-z0-9_@./-]+$/.test(p)||p.startsWith('/')||p.split('/').some(s=>!s||s==='.'||s==='..'))throw Error('unsafe_archive_path');}
 if(types.trim().split(/\r?\n/).some(l=>!/^[-d]/.test(l)))throw Error('archive_links_forbidden');
}

export async function install(operation,tag,env=process.env){
 if(!['install','activate'].includes(operation)||!/^v\d+\.\d+\.\d+$/.test(tag))throw Error('invalid_install_operation');
 const c=settings(env),temporary=mkdtempSync(join(tmpdir(),'automesh-server-github-'));
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 if(!env.SSH_PRIVATE_KEY?.includes('PRIVATE KEY-----')||!env.SSH_KNOWN_HOSTS?.trim())throw Error('ssh_credentials_missing');
 writeFileSync(join(temporary,'key'),env.SSH_PRIVATE_KEY.trim()+'\n',{mode:0o600});writeFileSync(join(temporary,'known_hosts'),env.SSH_KNOWN_HOSTS.trim()+'\n',{mode:0o600});
 const args=['-i',join(temporary,'key'),'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+join(temporary,'known_hosts'),'-o','ConnectTimeout=15','-o','ForwardAgent=no','-o','ClearAllForwardings=yes'];
 const run=(bin,args,options={})=>execFileSync(bin,args,{encoding:'utf8',timeout:360000,maxBuffer:4*1024*1024,stdio:['pipe','pipe','pipe'],...options});
 const remote=async(source)=>{
  try{const out=run('ssh',['-T','-p',c.port,...args,c.user+'@'+c.host,quote(c.bootstrapNode)+' --input-type=module -'],{input:'const c='+JSON.stringify(c)+';\n'+source});console.log(out.trim());}
  catch(e){const safe=(e.stderr||'').toString().match(/NODE_INSTALL_ERROR:([a-z0-9_]+)/);throw Error(safe?safe[1]:'remote_node_operation_failed');}
 };
 let nodeMayBeRunning=false;
 try{
  if(operation==='install'){
   if(!/^[-A-Za-z0-9_]+\/[-A-Za-z0-9_.]+$/.test(env.GITHUB_REPOSITORY||'')||!env.GITHUB_TOKEN)throw Error('github_context_required');
   const headers={Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
   const api=async p=>{const r=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${p}`,{headers,signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error('github_release_unavailable');return r.json();};
   const release=await api('releases/tags/'+tag),ref=await api('git/ref/tags/'+tag);
   if(release.draft||release.tag_name!==tag||ref.object.type!=='commit'||release.target_commitish!==ref.object.sha)throw Error('release_commit_mismatch');
   const asset=release.assets.find(a=>a.name===`Automesh-Server-Node-${tag.slice(1)}-cPanel.tar.gz`);
   if(!asset||asset.size>2*1024*1024||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||''))throw Error('server_asset_missing');
   const response=await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`,{headers:{...headers,Accept:'application/octet-stream'},signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw Error('server_asset_download_failed');const bytes=Buffer.from(await response.arrayBuffer());
   if(bytes.length!==asset.size||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==asset.digest)throw Error('server_asset_checksum');
   const archive=join(temporary,'server.tar.gz');writeFileSync(archive,bytes);
   archiveNames(run('tar',['-tzf',archive]),run('tar',['-tvzf',archive]));
   c.sha256=asset.digest.slice(7);c.version=tag.slice(1);
   await remote(`
    import fs from 'node:fs';import path from 'node:path';
    try{
      for(const p of [c.home,c.documentRoot]){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid())throw Error('unsafe_install_parent');}
      for(const name of ['.automesh-node-private','.automesh-node-data'])if(fs.existsSync(path.join(c.home,name)))throw Error('existing_node_data_preserved');
      if(fs.existsSync(c.root)&&(fs.lstatSync(c.root).isSymbolicLink()||!fs.lstatSync(c.root).isDirectory()||fs.existsSync(path.join(c.root,'package.json'))))throw Error('existing_node_app_preserved');
      const base=path.dirname(c.stage);if(!fs.existsSync(base))fs.mkdirSync(base,{mode:0o700});
      if(fs.lstatSync(base).isSymbolicLink())throw Error('unsafe_install_parent');fs.mkdirSync(c.stage,{mode:0o700});
      console.log('NODE_INSTALL_STAGE_READY');
    }catch(e){console.error('NODE_INSTALL_ERROR:'+(/^[a-z_]+$/.test(e.message)?e.message:'preflight_failed'));process.exitCode=1;}
   `);
   run('scp',['-P',c.port,...args,archive,c.user+'@'+c.host+':'+c.stage+'/server.tar.gz']);
   await remote(`
    import fs from 'node:fs';import path from 'node:path';import{spawnSync}from'node:child_process';import{createHash}from'node:crypto';import{pathToFileURL}from'node:url';
    const selector=(action,options=[])=>{const r=spawnSync('/sbin/cloudlinux-selector',[action,'--json','--interpreter','nodejs',...options],{encoding:'utf8',timeout:300000});let d;try{d=JSON.parse(r.stdout);}catch{}if(r.status!==0||d?.result!=='success')throw Error('selector_'+action.replaceAll('-','_')+'_failed');return d;};
    let registered=false;
    try{
      const archive=path.join(c.stage,'server.tar.gz');if(createHash('sha256').update(fs.readFileSync(archive)).digest('hex')!==c.sha256)throw Error('uploaded_checksum');
      const source=path.join(c.stage,'source');fs.mkdirSync(source,{mode:0o700});const tar=spawnSync('tar',['--no-same-owner','--no-same-permissions','-xzf',archive,'-C',source],{timeout:30000});if(tar.status!==0)throw Error('extraction_failed');
      const{verifySharedPackage}=await import(pathToFileURL(path.join(source,'scripts/verify-shared-package.mjs')));const verified=await verifySharedPackage(source);
      if(verified.version!==c.version||JSON.parse(fs.readFileSync(path.join(source,'release-files.json'))).sourceOnly!==true)throw Error('server_package_mismatch');
      for(const name of ['.automesh-node-private','.automesh-node-data'])if(fs.existsSync(path.join(c.home,name)))throw Error('existing_node_data_preserved');
      const found=[];function scan(v){if(!v||typeof v!=='object')return;if(v.applications?.['automesh-node-app'])found.push(v.applications['automesh-node-app']);for(const[k,s]of Object.entries(v))if(k!=='env_vars'&&k!=='applications')scan(s);}scan(selector('get'));
      if(found.length)throw Error('existing_node_registration_preserved');
      selector('create',['--domain',new URL(c.publicUrl).hostname,'--app-root','automesh-node-app','--app-uri','/','--version','24','--app-mode','production','--startup-file','app.cjs','--env-vars',JSON.stringify({NODE_ENV:'production',AUTOMESH_NODE_CONFIG:path.join(c.home,'.automesh-node-private/config.json')})]);registered=true;
      selector('stop',['--app-root','automesh-node-app']);
      if(fs.lstatSync(c.root).isSymbolicLink())throw Error('unsafe_application_root');
      const backup=path.join(c.stage,'initial-app');fs.mkdirSync(backup,{mode:0o700});for(const name of fs.readdirSync(c.root))if(!['node_modules','tmp'].includes(name))fs.cpSync(path.join(c.root,name),path.join(backup,name),{recursive:true,dereference:false});
      const manifest=JSON.parse(fs.readFileSync(path.join(source,'release-files.json')));
      for(const item of [...manifest.files,{path:'release-files.json'}]){const target=path.join(c.root,item.path);let p=c.root;for(const part of item.path.split('/')){p=path.join(p,part);if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('unsafe_destination_link');}fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,item.path),target);}
      selector('install-modules',['--app-root','automesh-node-app','--skip-web-check']);
      const node=path.join(c.home,'nodevenv/automesh-node-app/24/bin/node');const setup=spawnSync(node,[path.join(c.root,'scripts/setup-shared-host.mjs'),c.home,c.publicUrl,c.documentRoot,'39304',c.allowedOrigins[0]],{encoding:'utf8',timeout:60000});if(setup.status!==0)throw Error('private_node_setup_failed');
      const configFile=path.join(c.home,'.automesh-node-private/config.json');const config=JSON.parse(fs.readFileSync(configFile));config.allowedOrigins=c.allowedOrigins;const{validatePassengerConfig}=await import(pathToFileURL(path.join(c.root,'adapters/passenger/config.js')));validatePassengerConfig(config);fs.writeFileSync(configFile,JSON.stringify(config,null,2)+'\\n',{mode:0o600});
      fs.writeFileSync(path.join(c.stage,'installed.json'),JSON.stringify({version:c.version,sha256:c.sha256,configured:true,started:false}),{mode:0o600});
      console.log('NODE_INSTALL_CONFIGURED');
    }catch(e){if(registered)try{selector('stop',['--app-root','automesh-node-app']);}catch{}console.error('NODE_INSTALL_ERROR:'+(/^[a-z_]+$/.test(e.message)?e.message:'installation_failed'));process.exitCode=1;}
   `);
  }
  // A valid TLS frontend is required before activation; never bypass certificates.
  const tls=await fetch(c.publicUrl+'/',{redirect:'error',signal:AbortSignal.timeout(10000)});await tls.body?.cancel();
  await remote(`
   import fs from'node:fs';import path from'node:path';import{spawnSync}from'node:child_process';
   let targetVerified=false;try{const config=JSON.parse(fs.readFileSync(path.join(c.home,'.automesh-node-private/config.json')));if(config.publicUrl!==c.publicUrl||JSON.parse(fs.readFileSync(path.join(c.root,'package.json'))).version!==${JSON.stringify(tag.slice(1))})throw Error('activation_target_mismatch');targetVerified=true;const r=spawnSync('/sbin/cloudlinux-selector',['start','--json','--interpreter','nodejs','--app-root','automesh-node-app'],{encoding:'utf8',timeout:60000});if(r.status!==0||JSON.parse(r.stdout).result!=='success')throw Error('node_start_failed');console.log('NODE_INSTALL_STARTED');}catch(e){if(targetVerified)spawnSync('/sbin/cloudlinux-selector',['stop','--json','--interpreter','nodejs','--app-root','automesh-node-app'],{encoding:'utf8',timeout:60000});console.error('NODE_INSTALL_ERROR:'+(/^[a-z_]+$/.test(e.message)?e.message:'activation_failed'));process.exitCode=1;}
  `);
  nodeMayBeRunning=true;
  let info;for(let i=0;i<20;i++){try{const r=await fetch(c.publicUrl+'/node/info',{redirect:'error',signal:AbortSignal.timeout(5000)});const v=await r.json();if(r.ok&&v.role==='server'&&v.protocol===NODE_PROTOCOL){info=v;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
  if(!info)throw Error('public_node_probe_failed');
  console.log(JSON.stringify({serverNodeInstalled:true,version:tag.slice(1),publicHttpsVerified:true,privateStatePreserved:true}));
 }catch(e){
  // Failed checks leave this NEW node stopped; keep all generated keys/data intact.
  if(nodeMayBeRunning)try{await remote(`import{spawnSync}from'node:child_process';spawnSync('/sbin/cloudlinux-selector',['stop','--json','--interpreter','nodejs','--app-root','automesh-node-app'],{encoding:'utf8',timeout:60000});console.log('NODE_INSTALL_LEFT_STOPPED');`);}catch{}
  throw e;
 }finally{rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await install(process.argv[2],process.argv[3]);}catch(e){console.error('Server deployment stopped: '+e.message);process.exitCode=1;}
}
