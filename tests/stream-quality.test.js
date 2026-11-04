'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const q=require('../src/main/stream-quality');
test('quality: selection, persistence, partial results, manual zero and failures',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ubox-quality-')),file=path.join(dir,'quality.json'),uid='test-camera';
 try{
  assert.equal(await q.resolve(uid,undefined,file),0);
  await q.results(uid,[{streamIndex:0,status:'ok',width:640,height:360,measuredFps:15},{streamIndex:1,status:'ok',width:2304,height:1296,measuredFps:15}],file);
  assert.equal(await q.resolve(uid,undefined,file),1);assert.equal(await q.resolve(uid,0,file),0);
  await q.preference(uid,'manual',0,file);await q.results(uid,[{streamIndex:2,status:'no-usable-h264'}],file);
  assert.equal(await q.resolve(uid,undefined,file),0);assert.equal((await q.get(uid,file)).streams[1].width,2304);
  await q.preference(uid,'auto',undefined,file);assert.equal(await q.resolve(uid,undefined,file),1);
  await q.results(uid,[{streamIndex:1,status:'error'}],file);assert.equal(await q.resolve(uid,undefined,file),0);assert.equal((await q.get(uid,file)).streams[1].width,2304);
  await assert.rejects(q.preference(uid,'manual',2,file));await assert.rejects(q.get('__proto__',file));await assert.rejects(q.resolve(uid,'0',file));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('quality: concurrent writes preserve indexes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ubox-quality-')),file=path.join(dir,'quality.json');
 try{await Promise.all([0,1,2,3].map(i=>q.results('test-camera',[{streamIndex:i,status:'ok',width:640,height:360,measuredFps:15}],file)));assert.equal(Object.keys((await q.get('test-camera',file)).streams).length,4);}
 finally{await fs.rm(dir,{recursive:true,force:true});}
});
