'use strict';
const fsp=require('node:fs/promises'),path=require('node:path');
const SCHEMA_VERSION=1;
function safeUid(uid){if(typeof uid!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(uid))throw new Error('Unsafe camera UID');return uid;}
class CameraRegistry{
  constructor(file){this.file=path.resolve(file);this.data={schemaVersion:SCHEMA_VERSION,updatedAt:null,cameras:[]};}
  async load(){
    try{
      const parsed=JSON.parse(await fsp.readFile(this.file,'utf8'));
      if(parsed?.schemaVersion!==SCHEMA_VERSION||!Array.isArray(parsed.cameras))throw new Error('Invalid registry');
      this.data={schemaVersion:SCHEMA_VERSION,updatedAt:parsed.updatedAt||null,cameras:parsed.cameras.filter(x=>x&&typeof x.uid==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x.uid)).map(x=>({uid:x.uid,firstSeenAt:x.firstSeenAt||null,lastSeenAt:x.lastSeenAt||null,lastStreamCheckAt:x.lastStreamCheckAt||null,lastStreamActive:x.lastStreamActive===true,source:x.source||'device_list'}))};
    }catch(e){if(e.code!=='ENOENT')throw e;}
    return this.data;
  }
  async save(){this.data.updatedAt=new Date().toISOString();await fsp.mkdir(path.dirname(this.file),{recursive:true});const temporary=this.file+'.tmp-'+Date.now();await fsp.writeFile(temporary,JSON.stringify(this.data,null,2)+'\n');await fsp.rename(temporary,this.file);return this.data;}
  find(uid){return this.data.cameras.find(camera=>camera.uid===uid)||null;}
  async observe(uid,source='device_list'){
    safeUid(uid);const now=new Date().toISOString();let camera=this.find(uid);
    if(!camera){camera={uid,firstSeenAt:now,lastSeenAt:now,lastStreamCheckAt:null,lastStreamActive:false,source};this.data.cameras.push(camera);}
    else{camera.lastSeenAt=now;camera.source=source;}
    await this.save();return camera;
  }
  async markStream(uid,active,checkedAt=new Date().toISOString()){
    safeUid(uid);const camera=this.find(uid);if(!camera)throw new Error('Camera is not registered');
    camera.lastStreamCheckAt=checkedAt;camera.lastStreamActive=active===true;await this.save();return camera;
  }
  latest(){return this.data.cameras.length?this.data.cameras[this.data.cameras.length-1]:null;}
}
async function resolveCameraUid({explicitUid,activeSession,registry,items,infos}){
  if(explicitUid){safeUid(explicitUid);return {uid:explicitUid,source:'cli'};}
  if(activeSession?.identity?.uid){const uid=safeUid(activeSession.identity.uid);return {uid,source:'active-session'};}
  const known=registry.latest();
  if(known)return {uid:known.uid,source:'stored-camera'};
  if(items.length===1){const uid=safeUid(items[0].device_uid||items[0].uid);return {uid,source:'single-device'};}
  throw new Error('Set --uid: multiple cameras are known and no active session UID is available');
}
module.exports={CameraRegistry,resolveCameraUid,safeUid,SCHEMA_VERSION};
