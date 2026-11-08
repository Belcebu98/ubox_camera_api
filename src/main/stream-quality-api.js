'use strict';
const {execFile}=require('node:child_process');
const path=require('node:path');
const q=require('./stream-quality');
const fail=(status,message)=>Object.assign(new Error(message),{status});
let busy=false;
async function exclusive(action){if(busy)throw fail(409,'Quality operation already running');busy=true;try{return await action();}finally{busy=false;}}
async function handle(method,route,data,manager){
  let cameraUid;try{cameraUid=q.uid(data.uid||manager?.session?.identity.uid);}catch{throw fail(400,'Valid camera uid required');}
  if(method==='GET'&&route==='/api/cameras/streams')return {...await q.get(cameraUid),activeStreamIndex:manager?.session?.identity.uid===cameraUid?manager.session.identity.streamIndex:null,busy};
  if(method!=='POST')throw fail(405,'Method not allowed');
  return exclusive(async()=>{
    if(route==='/api/cameras/preferred-stream'){
      if(data.apply!==undefined&&typeof data.apply!=='boolean')throw fail(400,'apply must be boolean');
      if(data.apply&&!global.streamQualityController)throw fail(409,'Immediate application requires integrated recorder');
      if(data.apply)await global.streamQualityController.validate(cameraUid);
      try{await q.preference(cameraUid,data.selectionMode,data.streamIndex);}catch(e){throw fail(400,e.message);}
      if(data.apply)await global.streamQualityController.apply(cameraUid);
      return {...await q.get(cameraUid),applied:Boolean(data.apply)};
    }
    if(route!=='/api/cameras/quality-probe')throw fail(404,'Not found');
    const seconds=data.seconds??30;if(!Number.isInteger(seconds)||seconds<10||seconds>120)throw fail(400,'seconds must be 10..120');
    if(global.streamQualityController)return global.streamQualityController.probe(cameraUid,seconds);
    if(manager?.session)throw fail(409,'Stop manual stream before probing');
    return runProbe(cameraUid,seconds);
  });
}
let child=null;
function cancelProbe(){if(child)child.kill();}
function runProbe(cameraUid,seconds){return new Promise((resolve,reject)=>{
  child=execFile(process.execPath,[path.resolve(__dirname,'../../tools/quality-probe.js'),'--uid',q.uid(cameraUid),'--indexes','0,1,2,3','--seconds',String(seconds)],{cwd:path.resolve(__dirname,'../..'),timeout:650000,maxBuffer:2*1024*1024,windowsHide:true},(error,stdout)=>{
    child=null;if(error)return reject(fail(502,'Probe failed; inspect local diagnostic logs'));
    try{const report=JSON.parse(stdout);if(report.uid!==cameraUid||!Array.isArray(report.results))throw new Error('Invalid report');resolve(report);}catch{reject(fail(502,'Probe returned no complete JSON report'));}
  });
});}
module.exports={handle,isBusy:()=>busy,runProbe,cancelProbe};
