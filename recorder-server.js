'use strict';
const http=require('node:http'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process');
require('dotenv').config();
const {GETrequest,POSTrequest,LOGINrequest}=require('./src/main/requests');
const {makeUbiaRequest}=require('./src/main/helpers');
const {UBoxLiveStreamManager}=require('./src/stream/ubox-live-stream');
const {LiveMp4Muxer,parseNalUnits}=require('./src/stream/live-mp4');
const {CameraTelemetry}=require('./src/main/camera-telemetry');
const {RecordingStorage}=require('./src/main/recording-storage');
const hls=require('./src/main/h264-hls'),ffmpeg=require('ffmpeg-static');
function scrub(v){if(Array.isArray(v))return v.map(scrub);if(!v||typeof v!=='object')return v;return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/token|password|cookie|authorization|prefix|^loginId$|^loginPwd$/i.test(k)?'[REDACTED]':scrub(x)]));}
function run(args){return new Promise((resolve,reject)=>{const p=spawn(ffmpeg,args,{stdio:['ignore','ignore','pipe']});let tail='';const t=setTimeout(()=>p.kill('SIGKILL'),120000);p.stderr.on('data',c=>{tail=(tail+c).slice(-8000);});p.on('error',e=>{clearTimeout(t);reject(e);});p.on('close',code=>{clearTimeout(t);code===0?resolve():reject(new Error(`MP4 finalization failed (${code}): ${tail}`));});});}
async function main(){
  const store=new RecordingStorage({projectRoot:__dirname});await store.init();const root=store.paths.video;
  const port=Number(process.env.server_port||8020),fps=Number(process.env.recording_fps||15),seconds=Number(process.env.recording_segment_seconds||300),reserve=Number(process.env.recording_min_free_gb??2)*1024**3,index=Number(process.env.recording_stream_index||0);
  if(!Number.isInteger(port)||port<1||port>65535||!Number.isFinite(fps)||fps<1||fps>60||!Number.isFinite(seconds)||seconds<10||seconds>3600||!Number.isFinite(reserve)||reserve<0||!Number.isInteger(index)||index<0||index>3)throw new Error('Invalid recording/server configuration');
  process.env.server_port=String(port);
  const manager=global.liveStreams=new UBoxLiveStreamManager({dumpDir:path.join(root,'raw-disabled'),logDir:store.paths.cameraLogs,enableSessionLogs:true,enableDumpFiles:false});
  const emit=manager.emit.bind(manager),log=manager.writeSessionLog.bind(manager),openLog=manager.openSessionLog.bind(manager);
  manager.openSessionLog=session=>{manager.logDir=store.cameraLogDir(session.identity.uid);return openLog(session);};
  manager.emit=(name,detail={})=>{const row=emit(name,scrub(detail));if(process.env.stream_log_console==='true')console.log(JSON.stringify(row));return row;};
  manager.writeSessionLog=row=>log(scrub(row));
  let loginJob=null;
  function validLogin(){const u=global.userdata,age=Date.now()-Date.parse(u?.login_time);return Boolean(u?.token)&&Number.isFinite(age)&&age>=0&&age<Number(u.token_valid_hours)*3600000;}
  async function login(force=false){if(!force&&validLogin())return;if(!loginJob)loginJob=LOGINrequest().then(u=>{if(!u?.token)throw new Error('Login response has no token');global.userdata=u;}).finally(()=>{loginJob=null;});return loginJob;}
  try{global.userdata=JSON.parse(await fsp.readFile(path.join(__dirname,'.storedLogin.json'),'utf8'));}catch{}
  const telemetry=new CameraTelemetry({request:async()=>{await login();return makeUbiaRequest({},'/api/v2/user/device_list');},intervalSeconds:Number(process.env.battery_poll_seconds||300),lowPercent:Number(process.env.battery_low_percent??20)});
  let stopping=false,tickJob=null,session=null,current=null,sps=null,pps=null,freeBytes=null,lastError=null,lastFrame=0,lastStart=0,device=null,warming=false,warmRequest=null;const jobs=new Set();
  function report(e){lastError=e.message;console.error('[NVR]',e.message);store.appLog('error','recording-error',e.message);manager.emit('recording-error',{message:e.message});}
  function finalize(){
    const rec=current;current=null;if(!rec)return;rec.endedAt=new Date().toISOString();
    const job=(async()=>{
      await new Promise((resolve,reject)=>{rec.stream.once('finish',resolve);rec.stream.once('error',reject);rec.stream.end();});
      if(rec.failed)throw new Error('Recording write failed; partial file retained');
      await run(['-hide_banner','-loglevel','error','-i',rec.partial,'-map','0:v:0','-c:v','copy','-movflags','+faststart','-n',rec.processing]);
      await fsp.rename(rec.processing,rec.file);const st=await fsp.stat(rec.file);
      await store.writeMetadata(rec.id,{status:'completed',source:'local_capture',startedAt:rec.startedAt,endedAt:rec.endedAt,frames:rec.frames,fps,video:'original-h264',audio:false,bytes:st.size,timestampSource:'server-wall-clock/fixed-fps',timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});
      await fsp.unlink(rec.partial);manager.emit('recording-finalized',{file:rec.id,frames:rec.frames});
    })().catch(report).finally(()=>jobs.delete(job));jobs.add(job);
  }
  function writeFrame(frame){
    lastFrame=Date.now();if(session?.streamFormat!=='h264'){if(!lastError)report(new Error('Original-quality recording requires H.264; HEVC is not recorded'));return;}
    const nals=parseNalUnits(frame),changed=nals.some(n=>(n.type===7&&sps&&!sps.equals(n.data))||(n.type===8&&pps&&!pps.equals(n.data)));
    if(changed&&current)finalize();for(const n of nals){if(n.type===7)sps=Buffer.from(n.data);if(n.type===8)pps=Buffer.from(n.data);}const key=nals.some(n=>n.type===5);
    if(freeBytes===null||freeBytes<reserve){if(current)finalize();return;}if(current&&key&&Date.now()-current.startedMs>=seconds*1000)finalize();
    if(!current){
      if(!key||!sps||!pps)return;const now=new Date(),allocated=store.allocate(String(session.identity.uid),now),stream=fs.createWriteStream(allocated.partial,{flags:'wx'});
      const rec={...allocated,stream,startedAt:now.toISOString(),startedMs:Date.now(),frames:0,muxer:new LiveMp4Muxer({fps}),failed:false};stream.on('error',e=>{rec.failed=true;if(current===rec)current=null;report(e);});current=rec;
      frame=Buffer.concat([Buffer.from([0,0,0,1]),sps,Buffer.from([0,0,0,1]),pps,frame]);
    }
    if(current.stream.writableLength>32*1024*1024){finalize();throw new Error('Storage too slow; buffer limit reached');}const r=current.muxer.pushAnnexB(frame);if(!r)return;if(!current.frames)current.stream.write(r.init);current.stream.write(r.fragment);current.frames++;
  }
  function attach(next){finalize();session=next;sps=null;pps=null;lastFrame=0;if(!next)return;const original=next.broadcastH264.bind(next);next.broadcastH264=(frame,track='primary')=>{original(frame,track);if(!stopping&&session===next&&track==='primary')try{writeFrame(frame);}catch(e){report(e);}};manager.emit('recording-attached',{streamIndex:next.identity.streamIndex});}
  async function chooseCamera(){
    await login();let r=await makeUbiaRequest({},'/api/v2/user/device_list');if(![0,'0'].includes(r?.code)){if(Number(r?.code)>=500)throw new Error('UBox unavailable');await login(true);r=await makeUbiaRequest({},'/api/v2/user/device_list');}if(![0,'0'].includes(r?.code))throw new Error('Unable to list cameras');telemetry.observe(r);
    const items=Array.isArray(r.data?.items)?r.data.items:[],infos=Array.isArray(r.data?.infos)?r.data.infos:[],uid=process.env.recording_camera_uid||(items.length===1?items[0].device_uid||items[0].uid:'');if(!uid)throw new Error('Set recording_camera_uid: exactly one recording camera must be selected');const match=x=>(x?.device_uid||x?.uid)===uid,item=items.find(match),info=infos.find(match);if(!item&&!info)throw new Error('Configured camera not found');device={...item,...info,uid,raw:{...item,...info}};
  }
  async function warm(){if(warming||stopping||!session?.streamFormat||!session.h264Tracks.get('primary').frames)return;warming=true;try{await new Promise((resolve,reject)=>{const req=warmRequest=http.get(`http://127.0.0.1:${port}/api/stream/live.m3u8?track=primary`,res=>{res.resume();res.once('end',()=>res.statusCode===200?resolve():reject(new Error(`HLS HTTP ${res.statusCode}`)));res.on('error',reject);});req.setTimeout(25000,()=>req.destroy(new Error('HLS preparation timeout')));req.on('error',reject);});}catch(e){if(!stopping)report(e);}finally{warmRequest=null;warming=false;}}
  async function tick(){if(stopping)return;try{const disk=await fsp.statfs(root);freeBytes=Number(disk.bavail)*Number(disk.bsize);if(freeBytes<reserve){if(current)finalize();lastError='Recording paused: low disk space';}if(!manager.session){if(Date.now()-lastStart<15000)return;lastStart=Date.now();await chooseCamera();if(stopping)return;await manager.start(device,{streamIndex:index,fps});}if(stopping)return;if(session!==manager.session)attach(manager.session);const quiet=lastFrame?Date.now()-lastFrame:Date.now()-lastStart;if(session&&quiet>30000&&Date.now()-lastStart>30000){lastStart=Date.now();await hls.shutdownAll();await manager.stop();attach(null);return;}void warm();}catch(e){if(!stopping)report(e);}}
  function schedule(){if(!tickJob&&!stopping)tickJob=tick().finally(()=>{tickJob=null;});}
  function status(){return {camera:session?.identity.uid||null,connected:Boolean(manager.session),receiving:Boolean(lastFrame&&Date.now()-lastFrame<5000),recording:Boolean(current&&!current.failed),currentFile:current?.id||null,root,storagePaths:store.paths,freeBytes,lastError,finalizing:jobs.size,format:session?.streamFormat||null,fps,streamIndex:index};}
  async function video(req,res,url){
    let file;try{file=await store.resolveVideo(url.searchParams.get('id')||'');}catch(e){e.status=e.code==='ENOENT'?404:400;throw e;}const st=await fsp.stat(file);let start=0,end=st.size-1,code=200;const invalid=()=>{res.writeHead(416,{'Content-Range':`bytes */${st.size}`});res.end();};
    if(req.headers.range){const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!m||(!m[1]&&!m[2]))return invalid();if(!m[1])start=Math.max(0,st.size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=st.size)return invalid();code=206;}
    res.writeHead(code,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(code===206?{'Content-Range':`bytes ${start}-${end}/${st.size}`}:{})});if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  function json(res,code,data){if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
  async function staticFile(req,res,name,type,inject=false){let content=await fsp.readFile(path.join(__dirname,'public',name));if(inject)content=Buffer.from(content.toString().replace('</body>','<script src="/battery-panel.js"></script></body>'));res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Length':content.length});res.end(req.method==='HEAD'?undefined:content);}
  const server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://localhost'),route=url.pathname;if(stopping)return json(res,503,{error:'Server shutting down'});if(!['GET','HEAD','POST'].includes(req.method)){res.setHeader('Allow','GET, HEAD, POST');return json(res,405,{error:'Method not allowed'});}
    if(req.method==='POST'){if(route.startsWith('/api/stream/')||route.startsWith('/api/nvr/'))return json(res,409,{error:'Automatic recorder owns the camera session; manual stream mutations are disabled'});if(!route.startsWith('/api/'))return json(res,404,{error:'Not found'});await login();return await POSTrequest(req,res);}
    if(['/', '/index.html'].includes(route))return await staticFile(req,res,'recorder.html','text/html; charset=utf-8',true);if(route==='/battery-panel.js')return await staticFile(req,res,'battery-panel.js','application/javascript; charset=utf-8');if(route==='/api/nvr/video')return await video(req,res,url);if(req.method==='HEAD')return json(res,405,{error:'HEAD is supported for static files and recordings only'});
    if(route==='/api/nvr/cameras')return json(res,200,{...telemetry.snapshot(),activeCameraUid:session?.identity.uid||null});if(route==='/api/nvr/status')return json(res,200,status());
    if(route==='/api/nvr/recordings'){const kind=url.searchParams.get('kind')||'all';if(!['all','continuo','detecciones'].includes(kind))return json(res,400,{error:'Invalid kind'});return json(res,200,(await store.list({kind})).slice(0,500));}
    if(hls.isHlsRequest(route))return await hls.handleHlsRequest(req,res,url);if(route.startsWith('/api/')){if(!route.startsWith('/api/stream/'))await login();return await GETrequest(req,res);}return json(res,404,{error:'Not found'});
  }catch(e){store.appLog('error','http-error',e.message);console.error('[HTTP]',e.message);if(!res.headersSent)json(res,e.status||(e.code==='ENOENT'?404:500),{error:e.status?e.message:'Service error; inspect local logs'});else res.destroy();}});
  let timer,telemetryTimer;
  async function stop(code=0){if(stopping)return;stopping=true;clearInterval(timer);clearInterval(telemetryTimer);manager.restartSession=()=>{};const timeout=setTimeout(()=>process.exit(1),140000);timeout.unref();const closed=new Promise(resolve=>server.close(resolve));warmRequest?.destroy();try{await tickJob;attach(null);await hls.shutdownAll();await manager.stop();await Promise.all([...jobs]);}catch(e){store.appLog('error','shutdown-error',e.message);console.error('[SHUTDOWN]',e.message);code=1;}manager.closeSessionLog();for(const client of manager.sseClients)client.end();server.closeIdleConnections?.();await closed;store.appLog('info','shutdown',`exit ${code}`);clearTimeout(timeout);process.exit(code);}
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());process.on('unhandledRejection',e=>{store.appLog('error','fatal',e?.message||String(e));console.error('[FATAL]',e);void stop(1);});process.on('uncaughtException',e=>{store.appLog('error','fatal',e.message);console.error('[FATAL]',e);void stop(1);});server.on('error',e=>{store.appLog('error','server-error',e.message);console.error('[SERVER]',e.message);void stop(1);});
  server.listen(port,process.env.server_host||'127.0.0.1',()=>{store.appLog('info','startup',`port ${port}`);console.log(`UBox integrated API + recorder: http://localhost:${port} | ${root}`);telemetryTimer=setInterval(()=>{if(!stopping&&global.userdata?.token)void telemetry.refresh();},15000);timer=setInterval(schedule,5000);schedule();});
}
if(require.main===module)main().catch(e=>{console.error('[STARTUP]',e.message);process.exitCode=1;});
module.exports={main};
