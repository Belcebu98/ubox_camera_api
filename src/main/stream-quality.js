'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const defaultFile=path.resolve(__dirname,'../../data/stream-quality.json');
function uid(v){if(typeof v!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(v)||['__proto__','constructor','prototype'].includes(v))throw new Error('Invalid camera UID');return v;}
function index(v){if(!Number.isInteger(v)||v<0||v>3)throw new Error('streamIndex must be an integer 0..3');return v;}
function recommend(streams){return Object.entries(streams||{}).filter(([i,s])=>/^[0-3]$/.test(i)&&s?.status==='ok'&&[s.width,s.height,s.fps].every(n=>Number.isFinite(n)&&n>0)).sort((a,b)=>b[1].width*b[1].height*b[1].fps-a[1].width*a[1].height*a[1].fps||Number(a[0])-Number(b[0])).map(([i])=>Number(i))[0]??null;}
function selected(camera){return camera?.selectionMode==='manual'?index(camera.manualStreamIndex):recommend(camera?.streams);}
async function read(file){try{const data=JSON.parse(await fs.readFile(file,'utf8'));if(data.schemaVersion!==1||!data.cameras||typeof data.cameras!=='object'||Array.isArray(data.cameras))throw new Error('Invalid stream quality store');return data;}catch(e){if(e.code==='ENOENT')return {schemaVersion:1,cameras:{}};throw e;}}
async function mutate(cameraUid,update,file){
  uid(cameraUid);await fs.mkdir(path.dirname(file),{recursive:true});const lock=file+'.lock',deadline=Date.now()+5000;let handle;
  while(!handle){try{handle=await fs.open(lock,'wx');}catch(e){if(e.code!=='EEXIST'||Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,50));}}
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{const data=await read(file),camera=data.cameras[cameraUid]||{uid:cameraUid,streams:{},selectionMode:'auto',manualStreamIndex:null};update(camera);camera.recommendedStreamIndex=recommend(camera.streams);camera.updatedAt=new Date().toISOString();data.cameras[cameraUid]=camera;await fs.writeFile(temporary,JSON.stringify(data,null,2)+'\n');await fs.rename(temporary,file);return camera;}
  finally{try{await fs.unlink(temporary);}catch(e){if(e.code!=='ENOENT')console.error('Quality cleanup:',e.code);}finally{await handle.close();await fs.unlink(lock);}}
}
async function get(cameraUid,file=defaultFile){uid(cameraUid);const camera=(await read(file)).cameras[cameraUid]||{uid:cameraUid,streams:{},selectionMode:'auto',manualStreamIndex:null};return {...camera,recommendedStreamIndex:recommend(camera.streams),selectedStreamIndex:selected(camera)};}
async function results(cameraUid,measurements,file=defaultFile){
  if(!Array.isArray(measurements))throw new Error('Measurements must be an array');
  return mutate(cameraUid,camera=>{for(const r of measurements){const i=index(r.streamIndex),p=camera.streams[i]||{},valid=r.status==='ok'&&[r.width,r.height,r.measuredFps].every(n=>Number.isFinite(n)&&n>0);camera.streams[i]={...p,status:valid?'ok':r.status==='ok'?'invalid-measurement':r.status||'error',width:valid?r.width:p.width??null,height:valid?r.height:p.height??null,fps:valid?r.measuredFps:p.fps??null,bitrateKbps:valid?r.videoBitrateKbps??null:p.bitrateKbps??null,codec:valid?r.codec??null:p.codec??null,lastSuccessfulAt:valid?new Date().toISOString():p.lastSuccessfulAt??null,checkedAt:new Date().toISOString(),error:valid?null:r.error||'No usable video in latest probe'};}},file);
}
async function preference(cameraUid,mode,streamIndex,file=defaultFile){if(!['auto','manual'].includes(mode))throw new Error('selectionMode must be auto or manual');if(mode==='manual')index(streamIndex);return mutate(cameraUid,camera=>{if(mode==='manual'&&camera.streams[streamIndex]?.status!=='ok')throw new Error('Stream has no successful latest measurement');camera.selectionMode=mode;camera.manualStreamIndex=mode==='manual'?streamIndex:null;},file);}
async function resolve(cameraUid,explicit,file=defaultFile){if(explicit!==undefined&&explicit!==null)return index(explicit);return (await get(cameraUid,file)).selectedStreamIndex??0;}
module.exports={get,results,preference,resolve,recommend,selected,index,uid};
