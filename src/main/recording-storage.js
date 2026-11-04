'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
function day(date=new Date()){const p=n=>String(n).padStart(2,'0');return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;}
function resolvePaths({projectRoot=path.resolve(__dirname,'../..'),env=process.env}={}){
  const root=env.recording_dir||(process.platform==='win32'?'E:/camaras':'');
  if(!root||!path.isAbsolute(root))throw new Error('recording_dir must be an absolute path');
  const local=(key,fallback)=>path.resolve(projectRoot,env[key]||fallback);
  return {video:path.resolve(root),metadata:local('metadata_dir','data/recordings'),cameraLogs:local('camera_logs_dir','logs/cameras'),appLogs:local('app_logs_dir','logs/app'),diagnostics:local('diagnostics_dir','data/diagnostics'),downloads:local('downloads_state_dir','data/downloads')};
}
function parseId(id){
  if(typeof id!=='string')throw new Error('Invalid recording ID');
  const m=/^(?:(continuo|detecciones)\/)?([a-zA-Z0-9_-]{1,80})\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2}_[a-zA-Z0-9_-]+\.mp4)$/.exec(id);
  if(!m)throw new Error('Invalid recording ID');
  return {id,kind:m[1]||'continuo',legacy:!m[1],uid:m[2],day:m[3],filename:m[4]};
}
function inside(root,file){const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
class RecordingStorage{
  constructor(options={}){this.paths=resolvePaths(options);this.realRoot=null;}
  async init(){
    await fsp.mkdir(this.paths.video,{recursive:true});this.realRoot=await fsp.realpath(this.paths.video);await fsp.access(this.realRoot,fs.constants.W_OK);
    for(const key of ['metadata','cameraLogs','appLogs','diagnostics','downloads']){
      if(this.paths[key]===this.paths.video||inside(this.paths.video,this.paths[key]))throw new Error(`${key} must be outside the video directory`);
      await fsp.mkdir(this.paths[key],{recursive:true});
      const resolved=await fsp.realpath(this.paths[key]);
      if(resolved===this.realRoot||inside(this.realRoot,resolved))throw new Error(`${key} resolves inside the video directory`);
    }
    for(const kind of ['continuo','detecciones']){await fsp.mkdir(path.join(this.paths.video,kind),{recursive:true});await fsp.mkdir(path.join(this.paths.metadata,kind),{recursive:true});}
  }
  allocate(uid,date=new Date()){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(uid))throw new Error('Unsafe camera UID');
    const p=n=>String(n).padStart(2,'0'),d=day(date),name=`${d}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}_${String(date.getMilliseconds()).padStart(3,'0')}-${crypto.randomBytes(4).toString('hex')}.mp4`;
    const id=`continuo/${uid}/${d}/${name}`,file=path.join(this.paths.video,...id.split('/'));
    fs.mkdirSync(path.dirname(file),{recursive:true});return {id,file,partial:file.replace(/\.mp4$/,'.partial.mp4'),processing:file.replace(/\.mp4$/,'.processing.mp4')};
  }
  metadataFile(id){const x=parseId(id);return path.join(this.paths.metadata,x.kind,x.uid,x.day,x.filename+'.json');}
  async writeMetadata(id,data){
    const x=parseId(id),target=this.metadataFile(id);
    const value={...data,schemaVersion:2,recordingId:crypto.createHash('sha256').update(id).digest('hex'),cameraUid:x.uid,kind:x.kind,videoRelativePath:id};
    await fsp.mkdir(path.dirname(target),{recursive:true});
    const text=JSON.stringify(value,null,2)+'\n';
    try{
      const old=await fsp.readFile(target,'utf8');
      if(old===text)return {file:target,created:false};
      throw new Error(`Metadata conflict; existing file preserved: ${target}`);
    }catch(e){if(e.code!=='ENOENT')throw e;}
    const temporary=target+'.tmp-'+crypto.randomBytes(8).toString('hex');
    try{
      const handle=await fsp.open(temporary,'wx',0o600);
      try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}
      // A same-directory hard link publishes a completed file without replacing an existing one.
      await fsp.link(temporary,target);
      return {file:target,created:true};
    }finally{await fsp.unlink(temporary).catch(()=>{});}
  }
  async resolveVideo(id){parseId(id);const file=await fsp.realpath(path.join(this.paths.video,...id.split('/')));if(!inside(this.realRoot,file))throw new Error('Invalid recording path');return file;}
  cameraLogDir(uid,date=new Date()){
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(uid))throw new Error('Unsafe camera UID');
    return path.join(this.paths.cameraLogs,uid,day(date));
  }
  appLog(level,event,message){
    try{fs.appendFileSync(path.join(this.paths.appLogs,day()+'.jsonl'),JSON.stringify({at:new Date().toISOString(),level,event,message:String(message)})+'\n');}
    catch(e){console.error('[APP LOG]',e.code||'write failed');}
  }
  async list({kind='all'}={}){
    if(!['all','continuo','detecciones'].includes(kind))throw new Error('Invalid recording kind');
    const out=[];
    const walk=async(dir,parts=[])=>{
      for(const entry of await fsp.readdir(dir,{withFileTypes:true})){
        if(entry.isSymbolicLink())continue;
        const next=[...parts,entry.name],file=path.join(dir,entry.name);
        if(entry.isDirectory()){if(next.length<=3)await walk(file,next);continue;}
        if(!entry.isFile())continue;
        const id=next.join('/');let x;try{x=parseId(id);}catch{continue;}
        if(kind!=='all'&&x.kind!==kind)continue;
        try{
          const resolved=await this.resolveVideo(id),st=await fsp.stat(resolved);
          let metadata=null;try{const m=JSON.parse(await fsp.readFile(this.metadataFile(id),'utf8'));if(m.videoRelativePath===id)metadata=m;}catch{}
          out.push({id,name:x.filename,kind:x.kind,legacy:x.legacy,bytes:st.size,metadataAvailable:Boolean(metadata),sortTime:metadata?.startedAt||metadata?.startedAtUtc||st.mtime.toISOString()});
        }catch(e){if(e.code!=='ENOENT')throw e;}
      }
    };
    await walk(this.paths.video);return out.sort((a,b)=>String(b.sortTime).localeCompare(String(a.sortTime)));
  }
  async importLegacy({apply=false}={}){
    const report=[];
    for(const entry of await this.list()){
      const source=path.join(this.paths.video,...entry.id.split('/'))+'.json',target=this.metadataFile(entry.id);
      try{
        const real=await fsp.realpath(source);if(!inside(this.realRoot,real))throw new Error('Legacy metadata outside video root');
        const data=JSON.parse(await fsp.readFile(real,'utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid metadata object');
        const next={...data,status:data.status||'completed',timestampSource:data.timestampSource||'legacy-unverified'};
        if(apply){const result=await this.writeMetadata(entry.id,next);report.push({id:entry.id,source,target,status:result.created?'copied':'already-present'});}
        else{
          let status='would-copy';try{await fsp.access(target);status='target-exists-check-before-apply';}catch(e){if(e.code!=='ENOENT')throw e;}
          report.push({id:entry.id,source,target,status});
        }
      }catch(e){if(e.code!=='ENOENT')report.push({id:entry.id,source,target,status:'error',error:e.message});}
    }
    return report;
  }
}
module.exports={RecordingStorage,resolvePaths,parseId,inside,day};
