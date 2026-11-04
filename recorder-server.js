'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
require('dotenv').config();
const { LOGINrequest } = require('./src/main/requests');
const { makeUbiaRequest } = require('./src/main/helpers');
const { UBoxLiveStreamManager } = require('./src/stream/ubox-live-stream');
const { LiveMp4Muxer, parseNalUnits } = require('./src/stream/live-mp4');
const hls = require('./src/main/h264-hls');
const ffmpeg = require('ffmpeg-static');
function stamp(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
  return { day, time: `${day}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}` };
}
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, /token|password|prefix|^loginId$|^loginPwd$/i.test(k) ? '[REDACTED]' : scrub(v)]));
}
function run(args) {
  return new Promise((resolve,reject) => {
    const proc = spawn(ffmpeg,args,{stdio:['ignore','ignore','pipe']}); let tail='';
    const timer=setTimeout(()=>{proc.kill('SIGKILL');},120000);
    proc.stderr.on('data', chunk => {tail=(tail+chunk).slice(-8000);});
    proc.on('error', error=>{clearTimeout(timer);reject(error);});
    proc.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`MP4 finalization failed (${code}): ${tail}`));});
  });
}
async function main() {
  const rootValue=process.env.recording_dir || (process.platform==='win32' ? 'E:\\camaras' : '');
  if (!rootValue || !path.isAbsolute(rootValue)) throw new Error('Set recording_dir to an absolute existing storage location');
  const root=path.resolve(rootValue);
  await fsp.mkdir(root,{recursive:true});
  await fsp.access(root,fs.constants.W_OK);
  const realRoot=await fsp.realpath(root);
  const port=Number(process.env.server_port || 8020);
  const fps=Number(process.env.recording_fps || 15);
  const seconds=Number(process.env.recording_segment_seconds || 300);
  const reserve=Number(process.env.recording_min_free_gb || 2)*1024**3;
  const index=Number(process.env.recording_stream_index || 0);
  if(!Number.isInteger(port)||port<1||port>65535||!Number.isFinite(fps)||fps<1||fps>60||!Number.isFinite(seconds)||seconds<10||seconds>3600||!Number.isFinite(reserve)||reserve<0||!Number.isInteger(index)||index<0||index>3) throw new Error('Invalid recording/server configuration');
  process.env.server_port=String(port);
  const manager=global.liveStreams=new UBoxLiveStreamManager({dumpDir:path.join(root,'raw-disabled'),logDir:path.join(__dirname,'stream-logs'),enableSessionLogs:true,enableDumpFiles:false});
  const originalEmit=manager.emit.bind(manager), originalLog=manager.writeSessionLog.bind(manager);
  manager.emit=(event,detail={})=>{const row=originalEmit(event,scrub(detail));if(process.env.stream_log_console==='true')console.log(JSON.stringify(row));return row;};
  manager.writeSessionLog=row=>originalLog(scrub(row));
  let stopping=false,busy=false,session=null,sink=null,current=null,sps=null,pps=null,freeBytes=null,lastError=null,lastFrame=0,lastStart=0,device=null,warming=false;
  const jobs=new Set();
  function report(error){lastError=error.message;console.error('[NVR]',error.message);manager.emit('recording-error',{message:error.message});}
  function finalize() {
    const recording=current;current=null;if(!recording)return;
    const job=(async()=>{
      await new Promise((resolve,reject)=>{recording.stream.once('finish',resolve);recording.stream.once('error',reject);recording.stream.end();});
      if(recording.failed)throw new Error('Recording write failed; partial file retained');
      await run(['-hide_banner','-loglevel','error','-i',recording.partial,'-map','0:v:0','-c:v','copy','-movflags','+faststart','-n',recording.processing]);
      await fsp.rename(recording.processing,recording.final);
      await fsp.writeFile(recording.final+'.json',JSON.stringify({startedAt:recording.startedAt,endedAt:new Date().toISOString(),frames:recording.frames,fps,video:'original-h264',audio:false,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},null,2));
      await fsp.unlink(recording.partial);
      manager.emit('recording-finalized',{file:path.relative(root,recording.final),frames:recording.frames});
    })().catch(report).finally(()=>jobs.delete(job));jobs.add(job);
  }
  function writeFrame(frame) {
    lastFrame=Date.now();
    if(session?.streamFormat!=='h264'){if(!lastError)report(new Error('Original-quality MP4 recording currently requires H.264; HEVC is not recorded'));return;}
    const nals=parseNalUnits(frame);
    const changed=nals.some(nal => (nal.type===7&&sps&&!sps.equals(nal.data))||(nal.type===8&&pps&&!pps.equals(nal.data)));
    if(changed&&current)finalize();
    for(const nal of nals){if(nal.type===7)sps=Buffer.from(nal.data);if(nal.type===8)pps=Buffer.from(nal.data);}
    const key=nals.some(n=>n.type===5);
    if(freeBytes===null||freeBytes<reserve){if(current)finalize();return;}
    if(current&&key&&Date.now()-current.startedMs>=seconds*1000)finalize();
    if(!current){
      if(!key||!sps||!pps)return;
      const now=new Date(),name=stamp(now),uid=String(session.identity.uid);
      if(!/^[a-zA-Z0-9_-]{1,80}$/.test(uid))throw new Error('Unsafe camera UID');
      const dir=path.join(root,uid,name.day);fs.mkdirSync(dir,{recursive:true});
      const base=path.join(dir,`${name.time}_${String(now.getMilliseconds()).padStart(3,'0')}-${crypto.randomBytes(3).toString('hex')}`);
      const stream=fs.createWriteStream(base+'.partial.mp4',{flags:'wx'});
      const rec={stream,partial:base+'.partial.mp4',processing:base+'.processing.mp4',final:base+'.mp4',startedAt:now.toISOString(),startedMs:Date.now(),frames:0,muxer:new LiveMp4Muxer({fps}),failed:false};
      stream.on('error',error=>{rec.failed=true;if(current===rec)current=null;report(error);});current=rec;
      frame=Buffer.concat([Buffer.from([0,0,0,1]),sps,Buffer.from([0,0,0,1]),pps,frame]);
    }
    if(current.stream.writableLength>32*1024*1024){finalize();throw new Error('Storage too slow; recording paused at buffer limit');}
    const result=current.muxer.pushAnnexB(frame);if(!result)return;
    if(!current.frames)current.stream.write(result.init);
    current.stream.write(result.fragment);current.frames++;
  }
  function attach(next) {
    if(sink){sink.emit('close');sink=null;}finalize();session=next;sps=null;pps=null;lastFrame=Date.now();
    if(!next)return;
    // Observe new frames only; do not archive the manager's old backlog.
    const original=next.broadcastH264.bind(next);
    next.broadcastH264=(frame,track='primary')=>{
      original(frame,track);
      if(!stopping&&session===next&&track==='primary')try{writeFrame(frame);}catch(error){report(error);}
    };
    manager.emit('recording-attached',{streamIndex:next.identity.streamIndex});
  }
  async function credentials() {
    try{
      const saved=JSON.parse(await fsp.readFile(path.join(__dirname,'.storedLogin.json'),'utf8'));
      if(saved.token&&Date.now()-Date.parse(saved.login_time)<Number(saved.token_valid_hours)*3600000)global.userdata=saved;
    }catch{}
    if(!global.userdata?.token)await LOGINrequest();
    let response=await makeUbiaRequest({},'/api/v2/user/device_list');
    if(![0,'0'].includes(response?.code)){await LOGINrequest();response=await makeUbiaRequest({},'/api/v2/user/device_list');}
    if(![0,'0'].includes(response?.code))throw new Error('Unable to list cameras');
    const items=Array.isArray(response.data?.items)?response.data.items:[];
    const infos=Array.isArray(response.data?.infos)?response.data.infos:[];
    const uid=process.env.recording_camera_uid || (items.length===1 ? items[0].device_uid||items[0].uid : '');
    if(!uid)throw new Error('Set recording_camera_uid: account does not contain exactly one camera');
    const match=item=>(item?.device_uid||item?.uid)===uid;
    const item=items.find(match),info=infos.find(match);if(!item&&!info)throw new Error('Configured camera not found');
    device={...item,...info,uid,raw:{...item,...info}};
  }
  async function warm() {
    if(warming||!session?.streamFormat||!session.h264Tracks.get('primary').frames)return;
    warming=true;
    try{await new Promise((resolve,reject)=>{
      const req=http.get(`http://127.0.0.1:${port}/api/stream/live.m3u8?track=primary`,res=>{res.resume();res.once('end',()=>res.statusCode===200?resolve():reject(new Error(`HLS HTTP ${res.statusCode}`)));});
      req.setTimeout(25000,()=>req.destroy(new Error('HLS preparation timeout')));req.on('error',reject);
    });}catch(error){report(error);}finally{warming=false;}
  }
  async function tick(){
    if(busy||stopping)return;busy=true;
    try{
      const disk=await fsp.statfs(root);freeBytes=Number(disk.bavail)*Number(disk.bsize);
      if(freeBytes<reserve){if(current)finalize();lastError='Recording paused: low disk space';}
      if(!manager.session){
        if(Date.now()-lastStart<15000)return;lastStart=Date.now();
        await credentials();
        await manager.start(device,{streamIndex:index,fps});
      }
      if(session!==manager.session)attach(manager.session);
      if(session&&Date.now()-lastFrame>30000&&Date.now()-lastStart>30000){lastStart=Date.now();await hls.shutdownAll();await manager.stop();attach(null);return;}
      void warm();
    }catch(error){report(error);}finally{busy=false;}
  }
  function status(){return {camera:session?.identity.uid||null,connected:Boolean(manager.session),receiving:Date.now()-lastFrame<5000,recording:Boolean(current&&!current.failed),currentFile:current?path.relative(root,current.final):null,root,freeBytes,lastError,finalizing:jobs.size,format:session?.streamFormat||null,fps,streamIndex:index};}
  async function listFiles(dir=root,relative='',out=[]){
    const entries=await fsp.readdir(dir,{withFileTypes:true});
    for(const entry of entries){if(entry.isSymbolicLink())continue;const rel=path.join(relative,entry.name);if(entry.isDirectory()){if(relative.split(path.sep).filter(Boolean).length<2)await listFiles(path.join(dir,entry.name),rel,out);}else if(entry.isFile()&&entry.name.endsWith('.mp4')&&!/\.(partial|processing)\.mp4$/.test(entry.name)){const st=await fsp.stat(path.join(dir,entry.name));out.push({id:rel.split(path.sep).join('/'),name:entry.name,bytes:st.size});}}
    return out;
  }
  async function serveRecording(req,res,url){
    const id=url.searchParams.get('id')||'';
    if(!/^[a-zA-Z0-9_-]+\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}_[a-zA-Z0-9_-]+\.mp4$/.test(id))throw Object.assign(new Error('Invalid recording ID'),{status:400});
    const file=await fsp.realpath(path.join(root,...id.split('/'))),rel=path.relative(realRoot,file);
    if(rel.startsWith('..')||path.isAbsolute(rel))throw Object.assign(new Error('Invalid recording path'),{status:403});
    const st=await fsp.stat(file);let start=0,end=st.size-1,code=200;
    if(req.headers.range){
      const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if(!m||(!m[1]&&!m[2])){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end();}
      if(!m[1])start=Math.max(0,st.size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=st.size){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end();}code=206;
    }
    res.writeHead(code,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(code===206?{'Content-Range':`bytes ${start}-${end}/${st.size}`}:{})});
    if(req.method==='HEAD')return res.end();
    const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  function json(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost');
      if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'Recorder is automatic; manual start/stop is disabled'});
      if(url.pathname==='/'){const content=await fsp.readFile(path.join(__dirname,'public/recorder.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(content);}
      if(url.pathname==='/api/nvr/status')return json(res,200,status());
      if(url.pathname==='/api/nvr/recordings')return json(res,200,(await listFiles()).sort((a,b)=>b.id.localeCompare(a.id)).slice(0,500));
      if(url.pathname==='/api/nvr/video')return await serveRecording(req,res,url);
      if(hls.isHlsRequest(url.pathname))return await hls.handleHlsRequest(req,res,url);
      if(url.pathname==='/api/stream/live.h264')return manager.addH264Client(res,'primary');
      return json(res,404,{error:'Not found'});
    }catch(error){if(!res.headersSent)json(res,error.status||(error.code==='ENOENT'?404:500),{error:error.message});else res.destroy();}
  });
  let timer;
  async function stop(){
    if(stopping)return;stopping=true;clearInterval(timer);manager.restartSession=()=>{};
    const timeout=setTimeout(()=>process.exit(1),130000);timeout.unref();
    server.close();attach(null);await hls.shutdownAll();await manager.stop();await Promise.all([...jobs]);manager.closeSessionLog();clearTimeout(timeout);process.exit(0);
  }
  process.on('SIGINT',()=>stop().catch(report));process.on('SIGTERM',()=>stop().catch(report));
  server.on('error',error=>{report(error);void stop();});
  server.listen(port,process.env.server_host||'127.0.0.1',()=>{
    console.log(`NVR http://localhost:${port} | ${root} | original H.264; ${fps} FPS configured; no audio`);
    timer=setInterval(()=>void tick(),5000);void tick();
  });
}
if(require.main===module)main().catch(error=>{console.error('[STARTUP]',error.message);process.exitCode=1;});
module.exports={stamp};
