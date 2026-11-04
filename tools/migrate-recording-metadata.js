'use strict';
require('dotenv').config();
const path=require('node:path');
const {RecordingStorage}=require('../src/main/recording-storage');
(async()=>{
  const args=process.argv.slice(2);if(args.some(x=>x!=='--apply'))throw new Error('Usage: node tools/migrate-recording-metadata.js [--apply]');
  const store=new RecordingStorage({projectRoot:path.resolve(__dirname,'..')});await store.init();
  const report=await store.importLegacy({apply:args.includes('--apply')});
  console.log(JSON.stringify({mode:args.includes('--apply')?'copy-only':'dry-run',originalsDeleted:false,videosMoved:false,entries:report},null,2));
  if(report.some(x=>x.status==='error'))process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
