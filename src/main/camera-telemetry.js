'use strict';
function percentage(value) {
  if(typeof value!=='number'&&typeof value!=='string')return null;
  if(typeof value==='string'&&!/^\d+(?:\.\d+)?$/.test(value.trim()))return null;
  const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=100?n:null;
}
function charging(value) {
  if([true,1,'1','true'].includes(value))return true;
  if([false,0,'0','false'].includes(value))return false;
  return null;
}
function normalize(data,fetchedAt,lowPercent) {
  const map=new Map();
  for(const item of Array.isArray(data?.items)?data.items:[]){const uid=item?.device_uid||item?.uid;if(typeof uid==='string'&&uid)map.set(uid,{uid,name:item.device_name||uid,batteryPercent:null,charging:null,latestActivityAt:null});}
  for(const info of Array.isArray(data?.infos)?data.infos:[]){
    const d=info?.dynamic_info||{},uid=info?.device_uid||d.device_uid;
    if(typeof uid!=='string'||!uid)continue;
    const old=map.get(uid)||{uid,name:info.device_name||uid},seconds=Number(d.latest_active_utc);
    const date=Number.isFinite(seconds)&&seconds>0?new Date(seconds*1000):null;
    map.set(uid,{...old,batteryPercent:percentage(d.battery),charging:charging(d.is_battery_charging),latestActivityAt:date&&Number.isFinite(date.getTime())?date.toISOString():null});
  }
  return [...map.values()].map(row=>({...row,lowBattery:row.batteryPercent===null?null:row.batteryPercent<=lowPercent,fetchedAt,batteryMeasuredAt:null,source:'ubia-device-list'}));
}
class CameraTelemetry {
  constructor({request,intervalSeconds=300,lowPercent=20,now=Date.now}) {
    if(typeof request!=='function'||!Number.isFinite(intervalSeconds)||intervalSeconds<60||intervalSeconds>86400||!Number.isFinite(lowPercent)||lowPercent<0||lowPercent>100)throw new Error('Invalid battery telemetry settings');
    Object.assign(this,{request,intervalMs:intervalSeconds*1000,lowPercent,now,rows:[],fetchedMs:null,attemptMs:null,pending:null,error:null});
  }
  observe(response) {
    if(![0,'0'].includes(response?.code))throw new Error('Battery metadata unavailable from UBox');
    const at=this.now();this.rows=normalize(response.data,new Date(at).toISOString(),this.lowPercent);this.fetchedMs=at;this.error=null;
  }
  refresh() {
    if(this.pending)return this.pending;
    const now=this.now();
    if((this.attemptMs!==null&&now-this.attemptMs<this.intervalMs)||(this.fetchedMs!==null&&now-this.fetchedMs<this.intervalMs))return Promise.resolve();
    this.attemptMs=now;
    this.pending=Promise.resolve().then(()=>this.request()).then(r=>this.observe(r)).catch(()=>{this.error='No se pudo actualizar la telemetría de UBox';}).finally(()=>{this.pending=null;});
    return this.pending;
  }
  snapshot() {
    const age=this.fetchedMs===null?null:Math.max(0,this.now()-this.fetchedMs);
    return {cameras:this.rows,ageSeconds:age===null?null:Math.floor(age/1000),stale:age===null||age>this.intervalMs*2,error:this.error,intervalSeconds:this.intervalMs/1000,lowPercent:this.lowPercent,simultaneousRecording:false};
  }
}
module.exports={CameraTelemetry,normalize,percentage,charging};
