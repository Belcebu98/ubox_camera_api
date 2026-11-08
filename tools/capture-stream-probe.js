'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
function createCapture({directory,uid,seconds=60,maxBytes=2*1024*1024,now=Date.now}) {
  if(!path.isAbsolute(directory)||!Number.isFinite(seconds)||seconds<1||seconds>120||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>8*1024*1024)throw new Error('Invalid probe limits or directory');
  const started=now(),safe=String(uid||'unknown').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80);
  const folder=path.join(directory,new Date(started).toISOString().replace(/[:.]/g,'-')+'-'+safe+'-'+crypto.randomBytes(4).toString('hex'));
  fs.mkdirSync(folder,{recursive:true});
  const meta=fs.openSync(path.join(folder,'records.jsonl'),'wx',0o600),data=fs.openSync(path.join(folder,'type-0x13-candidate.bin'),'wx',0o600);
  let closed=false,used=0,offset=0;
  const line=row=>Buffer.from(JSON.stringify(row)+'\n');
  const header=line({kind:'probe-start',observedAt:new Date(started).toISOString(),uid:String(uid||''),seconds,maxBytes,meaning:'0x13 is unidentified; no audio/PIR classification asserted'});
  fs.writeSync(meta,header);used+=header.length;
  function close(){if(closed)return;closed=true;clearTimeout(timer);fs.closeSync(meta);fs.closeSync(data);}
  const timer=setTimeout(close,seconds*1000);timer.unref();
  function record(rec) {
    if(closed)return;
    if(now()-started>=seconds*1000){close();return;}
    if(!rec||rec.type===0x11||rec.type===0x14)return;
    const payload=rec.type===0x13&&Buffer.isBuffer(rec.payload)?rec.payload:null;
    const row={kind:'inner-record',observedAt:new Date(now()).toISOString(),type:rec.type,frameSeq:rec.frameSeq,payloadBytes:Buffer.isBuffer(rec.payload)?rec.payload.length:0,frameMeta:rec.frameMeta?{codec:rec.frameMeta.codec,flags:rec.frameMeta.flags,cam:rec.frameMeta.cam,online:rec.frameMeta.online,timestamp:rec.frameMeta.timestamp}:null,...(payload?{candidateOffset:offset,candidateBytes:payload.length}:{})};
    const encoded=line(row),needed=encoded.length+(payload?payload.length:0);
    if(used+needed>maxBytes){close();return;}
    if(payload){fs.writeSync(data,payload);offset+=payload.length;}
    fs.writeSync(meta,encoded);used+=needed;
  }
  return {folder,record,close,get closed(){return closed;},get bytes(){return used;}};
}
if(process.env.UBOX_STREAM_PROBE==='1') {
  require('dotenv').config();
  const {UBoxLiveStreamManager,parseInnerRecord}=require('../src/stream/ubox-live-stream');
  if(typeof parseInnerRecord!=='function')throw new Error('parseInnerRecord is not exported by this project version');
  const originalStart=UBoxLiveStreamManager.prototype.start;
  let capture=null,installed=false;
  UBoxLiveStreamManager.prototype.start=async function(...args){
    const result=await originalStart.apply(this,args),session=this.session;
    if(installed||!session||typeof session.handleKcpMessage!=='function')return result;
    const uid=session.identity?.uid;
    if(process.env.recording_camera_uid&&uid!==process.env.recording_camera_uid)return result;
    installed=true;
    try{
      const root=process.env.recording_dir||(process.platform==='win32'?'E:/camaras':'');
      capture=createCapture({directory:path.join(path.resolve(root),'_diagnostics'),uid,seconds:60,maxBytes:2*1024*1024});
      const original=session.handleKcpMessage;
      session.handleKcpMessage=function(message){
        const value=original.call(this,message);
        if(!capture.closed)try{capture.record(parseInnerRecord(message));}catch(error){console.error('[PROBE]',error.message);capture.close();}
        return value;
      };
      console.log('[PROBE] Private local capture, maximum 60 seconds / 2 MiB:',capture.folder);
    }catch(error){console.error('[PROBE] Not capturing:',error.message);}
    return result;
  };
  process.on('exit',()=>capture?.close());
}
module.exports={createCapture};
