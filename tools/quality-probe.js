'use strict';
require('dotenv').config();
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process');
const {LOGINrequest}=require('../src/main/requests');
const {makeUbiaRequest}=require('../src/main/helpers');
const {UBoxLiveStreamManager}=require('../src/stream/ubox-live-stream');
const {LiveMp4Muxer,parseNalUnits}=require('../src/stream/live-mp4');
const {parseSpsDimensions}=require('../src/stream/sps');
const {detectStreamFormat}=require('../src/stream/video-codec');
const {parseArgs}=require('./quality-probe-args.js');
const {CameraRegistry,resolveCameraUid}=require('../src/main/camera-registry');
const ffmpeg=require('ffmpeg-static');
function scrub(v){if(Array.isArray(v))return v.map(scrub);if(!v||typeof v!=='object')return v;return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/token|password|cookie|authorization|prefix|^loginId$|^loginPwd$/i.test(k)?'[REDACTED]':scrub(x)]));}
function runFFmpeg(args,timeoutMs=180000){return new Promise((resolve,reject)=>{const child=spawn(ffmpeg,args,{stdio:['ignore','ignore','pipe']});let tail='';const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);child.stderr.on('data',chunk=>{tail=(tail+chunk).slice(-8000);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`FFmpeg failed (${code}): ${tail}`));});});}
function deviceUid(device){return device?.device_uid||device?.uid||device?.deviceInfo?.device_uid||device?.info?.device_uid||null;}
function sessionDiagnostics(session){
  const counters=session?.counters||{};
  return {rx:counters.rx||0,kcpSegments:counters.kcpSegments||0,kcpMessages:counters.kcpMessages||0,videoFrames:counters.videoFrames||0,annexBFrames:counters.annexBFrames||0,rdtFrames:counters.rdtFrames||0,h264DroppedFrames:counters.h264DroppedFrames||0,lastH264AgeMs:session?.lastH264At?Date.now()-session.lastH264At:null,lastKcpInputAgeMs:session?.lastKcpInputAt?Date.now()-session.lastKcpInputAt:null,relayEstablished:Boolean(session?.relayEstablished),relayPeer:session?.relayPeer||null,sessionState:session?.sessionState?.state??null,streamFormat:session?.streamFormat||null};
}
function attachProbe(session,onFrame){
  if(!session||typeof session.broadcastH264!=='function')throw new Error('Active UBox session is unavailable');
  const original=session.broadcastH264.bind(session);
  session.broadcastH264=(frame,track='primary')=>{original(frame,track);if(track==='primary')onFrame(frame);};
}
async function probeIndex({manager,device,index,seconds,fps,outDir}){
  const uid=deviceUid(device),started=Date.now();let frames=0,bytes=0,keyframes=0,firstFrameAt=null,lastFrameAt=null,sps=null,pps=null,codec=null,width=null,height=null,streamFormat=null,receiveGaps=0;
  const file=path.join(outDir,`stream-${index}.mp4`),temporary=file+'.partial.mp4',processing=file+'.processing.mp4';
  await fsp.unlink(temporary).catch(()=>{});await fsp.unlink(processing).catch(()=>{});
  const stream=fs.createWriteStream(temporary,{flags:'wx'}),muxer=new LiveMp4Muxer({fps});
  await manager.start(device,{streamIndex:index,fps,forceRestart:true});
  const session=manager.session;
  attachProbe(session,frame=>{
    const now=Date.now();if(!streamFormat)streamFormat=detectStreamFormat(frame);if(streamFormat!=='h264')return;
    const nals=parseNalUnits(frame),picture=nals.find(n=>n.type===1||n.type===5);
    if(picture){frames++;if(firstFrameAt===null)firstFrameAt=now;else if(now-lastFrameAt>1000)receiveGaps++;lastFrameAt=now;}
    const spsNal=nals.find(n=>n.type===7),ppsNal=nals.find(n=>n.type===8),key=nals.some(n=>n.type===5);
    if(spsNal){sps=Buffer.from(spsNal.data);const dimensions=parseSpsDimensions(sps);width=dimensions.width;height=dimensions.height;}
    if(ppsNal)pps=Buffer.from(ppsNal.data);if(key)keyframes++;
    if(sps&&pps){const result=muxer.pushAnnexB(frame);if(result){if(!bytes)stream.write(result.init);stream.write(result.fragment);bytes+=result.fragment.length;codec=result.codec;}}
  });
  try{await new Promise(resolve=>setTimeout(resolve,seconds*1000));}finally{try{await manager.stop();}finally{await new Promise((resolve,reject)=>{stream.once('finish',resolve);stream.once('error',reject);stream.end();});}}
  const diagnostics=sessionDiagnostics(session);
  if(!bytes||!sps||!pps){await fsp.unlink(temporary).catch(()=>{});return {schemaVersion:1,uid,streamIndex:index,startedAt:new Date(started).toISOString(),durationSeconds:seconds,status:'no-usable-h264',error:`No usable H.264 frames on stream index ${index}`,frames,keyframes,codec,width,height,streamFormat,bytes,receiveGaps,diagnostics};}
  await runFFmpeg(['-hide_banner','-loglevel','error','-i',temporary,'-map','0:v:0','-c:v','copy','-movflags','+faststart','-n',processing]);
  await fsp.rename(processing,file);await fsp.unlink(temporary);
  const elapsed=(lastFrameAt-firstFrameAt)/1000;
  return {schemaVersion:1,uid,streamIndex:index,startedAt:new Date(started).toISOString(),durationSeconds:seconds,status:'ok',codec,streamFormat,width,height,frames,keyframes,measuredFps:elapsed>0?Number((frames/elapsed).toFixed(2)):null,videoBitrateKbps:elapsed>0?Math.round(bytes*8/elapsed/1000):null,bytes,receiveGaps,gapThresholdMs:1000,measurement:'camera-stream-frame-count',timestampSource:'client-receive-time',sampleFile:path.relative(process.cwd(),file),diagnostics,caveats:['Resolution comes from SPS and may be encoded/cropped dimensions.','FPS is receive rate during a short probe, not a guaranteed camera setting.','receiveGaps counts reception pauses over 1 second; it does not identify lost frames.','A higher stream index is not inherently higher quality.']};
}
async function verifyStreamActive({manager,device,waitMs=15000}){
  const uid=deviceUid(device);let frames=0,lastFrameAt=null,format=null;
  await manager.start(device,{streamIndex:0,fps:15,forceRestart:true});
  const session=manager.session;
  attachProbe(session,frame=>{const now=Date.now();if(!format)format=detectStreamFormat(frame);const nals=parseNalUnits(frame);if(nals.some(n=>n.type===1||n.type===5)){frames++;lastFrameAt=now;}});
  try{await new Promise(resolve=>setTimeout(resolve,waitMs));}finally{await manager.stop();}
  const active=frames>0&&lastFrameAt!==null&&Date.now()-lastFrameAt<5000;
  return {uid,streamActive:active,frames,format,checkedAt:new Date().toISOString(),waitMs,lastFrameAgeMs:lastFrameAt?Date.now()-lastFrameAt:null,diagnostics:sessionDiagnostics(session),meaning:active?'Camera sent at least one H.264 picture frame during the check':'No H.264 picture frame was received during the initial check; individual stream indexes will still be tested'};
}
(async()=>{
  const options=parseArgs(process.argv.slice(2));await fsp.mkdir(options.outDir,{recursive:true});
  const registryFile=path.resolve(process.cwd(),'data/cameras.json'),registry=new CameraRegistry(registryFile);await registry.load();
  await LOGINrequest();const list=await makeUbiaRequest({},'/api/v2/user/device_list');if(![0,'0'].includes(list?.code))throw new Error('Unable to list cameras');
  const items=Array.isArray(list.data?.items)?list.data.items:[],infos=Array.isArray(list.data?.infos)?list.data.infos:[];
  const devicesByUid=new Map();
  for(const device of [...items,...infos]){const uid=deviceUid(device);if(uid){devicesByUid.set(uid,device);await registry.observe(uid,'device_list');}}
  const selected=await resolveCameraUid({explicitUid:options.uid,activeSession:null,registry,items,infos});
  const device=devicesByUid.get(selected.uid);
  if(!device)throw new Error(`Camera ${selected.uid} was not found in device_list; cannot obtain stream credentials`);
  await registry.observe(selected.uid,selected.source);
  const manager=new UBoxLiveStreamManager({dumpDir:path.join(options.outDir,'raw-disabled'),logDir:path.join(options.outDir,'session-logs'),enableSessionLogs:true,enableDumpFiles:false});
  const originalEmit=manager.emit.bind(manager);manager.emit=(event,detail={})=>originalEmit(event,scrub(detail));
  const liveness=await verifyStreamActive({manager,device,waitMs:15000});
  await registry.markStream(selected.uid,liveness.streamActive,liveness.checkedAt);
  const results=[];
  for(const index of options.indexes){try{results.push(await probeIndex({manager,device,index,seconds:options.seconds,fps:options.fps,outDir:options.outDir}));}catch(error){results.push({schemaVersion:1,uid:selected.uid,streamIndex:index,status:'error',error:error.message});}}
  const usable=results.filter(r=>r.status==='ok'&&r.width&&r.height),ranked=usable.map(r=>({...r,score:(r.width*r.height)*(r.measuredFps||0)})).sort((a,b)=>b.score-a.score);
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),uid:selected.uid,uidSource:selected.source,streamCheck:liveness,indexesTested:options.indexes,probeSeconds:options.seconds,results,recommendation:ranked[0]?{streamIndex:ranked[0].streamIndex,reason:'Highest measured resolution-times-FPS among successful probes; validate visually before changing recording'}:null,warning:liveness.streamActive?null:'Initial stream check found no H.264 frames; individual index diagnostics below indicate where the session stalls.'};
  await fsp.writeFile(path.join(options.outDir,'quality-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
