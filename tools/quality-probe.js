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
const ffmpeg=require('ffmpeg-static');
function scrub(v){if(Array.isArray(v))return v.map(scrub);if(!v||typeof v!=='object')return v;return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/token|password|cookie|authorization|prefix|^loginId$|^loginPwd$/i.test(k)?'[REDACTED]':scrub(x)]));}
function runFFmpeg(args,timeoutMs=180000){return new Promise((resolve,reject)=>{const child=spawn(ffmpeg,args,{stdio:['ignore','ignore','pipe']});let tail='';const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);child.stderr.on('data',chunk=>{tail=(tail+chunk).slice(-8000);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`FFmpeg failed (${code}): ${tail}`));});});}
async function probeIndex({manager,uid,index,seconds,fps,outDir}){
  const started=Date.now();let frames=0,bytes=0,keyframes=0,firstFrameAt=null,lastFrameAt=null,sps=null,pps=null,codec=null,width=null,height=null,streamFormat=null,gaps=0,lastSeq=null;
  const file=path.join(outDir,`stream-${index}.mp4`),metadata=path.join(outDir,`stream-${index}.json`),temporary=file+'.partial.mp4',processing=file+'.processing.mp4';
  const stream=fs.createWriteStream(temporary,{flags:'wx'}),muxer=new LiveMp4Muxer({fps});
  const session=await manager.start({uid},{streamIndex:index,fps,forceRestart:true});
  const original=session.broadcastH264.bind(session);
  session.broadcastH264=(frame,track='primary')=>{
    original(frame,track);if(track!=='primary')return;
    const now=Date.now();if(!streamFormat)streamFormat=detectStreamFormat(frame);if(streamFormat!=='h264')return;
    const nals=parseNalUnits(frame),picture=nals.find(n=>n.type===1||n.type===5);
    if(picture){frames++;if(firstFrameAt===null)firstFrameAt=now;lastFrameAt=now;if(lastSeq!==null&&picture!==lastSeq+1)gaps++;lastSeq=picture;}
    const spsNal=nals.find(n=>n.type===7),ppsNal=nals.find(n=>n.type===8),key=nals.some(n=>n.type===5);
    if(spsNal){sps=Buffer.from(spsNal.data);const dimensions=parseSpsDimensions(sps);width=dimensions.width;height=dimensions.height;}
    if(ppsNal)pps=Buffer.from(ppsNal.data);if(key)keyframes++;
    if(sps&&pps){const result=muxer.pushAnnexB(frame);if(result){if(!bytes)stream.write(result.init);stream.write(result.fragment);bytes+=result.fragment.length;codec=result.codec;}}
  };
  try{await new Promise(resolve=>setTimeout(resolve,seconds*1000));}finally{await manager.stop();await new Promise((resolve,reject)=>{stream.once('finish',resolve);stream.once('error',reject);stream.end();});}
  if(!bytes||!sps||!pps)throw new Error(`No usable H.264 frames on stream index ${index}`);
  await runFFmpeg(['-hide_banner','-loglevel','error','-i',temporary,'-map','0:v:0','-c:v','copy','-movflags','+faststart','-n',processing]);
  await fsp.rename(processing,file);await fsp.unlink(temporary);
  const stat=await fsp.stat(file),elapsed=(lastFrameAt-firstFrameAt)/1000;
  const result={schemaVersion:1,uid,streamIndex:index,startedAt:new Date(started).toISOString(),durationSeconds:seconds,codec,streamFormat,width,height,frames,keyframes,measuredFps:elapsed>0?Number((frames/elapsed).toFixed(2)):null,videoBitrateKbps:elapsed>0?Math.round(bytes*8/elapsed/1000):null,bytes,gaps,frameSequenceGaps:gaps,measurement:'camera-stream-frame-count',timestampSource:'client-receive-time',sampleFile:path.relative(process.cwd(),file),caveats:['Resolution comes from SPS and may be encoded/cropped dimensions.','FPS is receive rate during a short probe, not a guaranteed camera setting.','A higher stream index is not inherently higher quality.']};
  await fsp.writeFile(metadata,JSON.stringify(result,null,2)+'\n');return result;
}
(async()=>{
  const options=parseArgs(process.argv.slice(2));await fsp.mkdir(options.outDir,{recursive:true});
  await LOGINrequest();const list=await makeUbiaRequest({},'/api/v2/user/device_list');if(![0,'0'].includes(list?.code))throw new Error('Unable to list cameras');
  const items=Array.isArray(list.data?.items)?list.data.items:[],infos=Array.isArray(list.data?.infos)?list.data.infos:[],uid=options.uid||(items.length===1?items[0].device_uid||items[0].uid:'');if(!uid)throw new Error('Set --uid or ensure the account has exactly one camera');
  const match=x=>(x?.device_uid||x?.uid)===uid;if(!items.find(match)&&!infos.find(match))throw new Error('Configured camera not found');
  const manager=new UBoxLiveStreamManager({dumpDir:path.join(options.outDir,'raw-disabled'),logDir:path.join(options.outDir,'session-logs'),enableSessionLogs:true,enableDumpFiles:false});
  const originalEmit=manager.emit.bind(manager);manager.emit=(event,detail={})=>originalEmit(event,scrub(detail));
  const results=[];
  for(const index of options.indexes){try{results.push(await probeIndex({manager,uid,index,seconds:options.seconds,fps:options.fps,outDir:options.outDir}));}catch(error){results.push({streamIndex:index,error:error.message,uid});}}
  const usable=results.filter(r=>!r.error&&r.width&&r.height),ranked=usable.map(r=>({...r,score:(r.width*r.height)*(r.measuredFps||0)})).sort((a,b)=>b.score-a.score);
  const report={schemaVersion:1,generatedAt:new Date().toISOString(),uid,indexesTested:options.indexes,probeSeconds:options.seconds,results,recommendation:ranked[0]?{streamIndex:ranked[0].streamIndex,reason:'Highest measured resolution-times-FPS among successful probes; validate visually before changing recording'}:null,warning:'This probe does not increase camera quality and does not change recording_stream_index.'};
  const reportFile=path.join(options.outDir,'quality-report.json');await fsp.writeFile(reportFile,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
