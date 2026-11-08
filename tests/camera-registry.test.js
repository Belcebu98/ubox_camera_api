'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {CameraRegistry,resolveCameraUid,safeUid}=require('../src/main/camera-registry');
async function temp(){return path.join(await fs.mkdtemp(path.join(os.tmpdir(),'cam-reg-')),'data/cameras.json');}
test('registers detected cameras and updates timestamps without secrets',async()=>{const file=await temp();const registry=new CameraRegistry(file);await registry.load();await registry.observe('CAM_A','device_list');const first=registry.find('CAM_A');await registry.observe('CAM_A','active-session');const second=registry.find('CAM_A');assert.equal(second.uid,'CAM_A');assert.equal(second.source,'active-session');assert.ok(Date.parse(second.lastSeenAt)>=Date.parse(first.lastSeenAt));const raw=await fs.readFile(file,'utf8');assert.ok(!/password|token|cookie/i.test(raw));});
test('stores stream liveness separately from discovery',async()=>{const file=await temp();const registry=new CameraRegistry(file);await registry.load();await registry.observe('CAM_A');await registry.markStream('CAM_A',true,'2026-11-04T18:00:00Z');assert.equal(registry.find('CAM_A').lastStreamActive,true);assert.equal(registry.find('CAM_A').lastStreamCheckAt,'2026-11-04T18:00:00Z');});
test('selects explicit UID, active session, stored camera, then single device',async()=>{const file=await temp();const registry=new CameraRegistry(file);await registry.load();await registry.observe('STORED');const items=[{uid:'ONLY'}],infos=[];
  assert.deepEqual(await resolveCameraUid({explicitUid:'EXPLICIT',registry,items,infos}),{uid:'EXPLICIT',source:'cli'});
  assert.deepEqual(await resolveCameraUid({activeSession:{identity:{uid:'ACTIVE'}},registry,items,infos}),{uid:'ACTIVE',source:'active-session'});
  assert.deepEqual(await resolveCameraUid({registry,items,infos}),{uid:'STORED',source:'stored-camera'});
  assert.deepEqual(await resolveCameraUid({registry:new CameraRegistry(path.join(path.dirname(file),'empty.json')),items,infos}),{uid:'ONLY',source:'single-device'});
  await assert.rejects(resolveCameraUid({registry:new CameraRegistry(path.join(path.dirname(file),'empty2.json')),items:[{uid:'A'},{uid:'B'}],infos}),/multiple cameras/);});
test('rejects unsafe UIDs',()=>{assert.throws(()=>safeUid('../bad'),/Unsafe/);assert.throws(()=>safeUid(''),/Unsafe/);});
