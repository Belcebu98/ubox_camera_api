'use strict';
const path=require('node:path');
function parseArgs(argv){
  const options={indexes:[0,1,2,3],seconds:25,outDir:path.resolve(process.cwd(),'data/diagnostics/quality-probe'),fps:15};
  for(let i=0;i<argv.length;i++){
    const value=argv[i+1];
    if(argv[i]==='--indexes')options.indexes=value.split(',').map(Number);
    else if(argv[i]==='--seconds')options.seconds=Number(value);
    else if(argv[i]==='--out')options.outDir=path.resolve(value);
    else if(argv[i]==='--fps')options.fps=Number(value);
    else if(argv[i]==='--uid')options.uid=value;
    else if(!argv[i].startsWith('--'))throw new Error(`Unknown argument: ${argv[i]}`);
    if(value===undefined)throw new Error(`Missing value for ${argv[i]}`);
    i++;
  }
  if(!Array.isArray(options.indexes)||!options.indexes.length||options.indexes.some(n=>!Number.isInteger(n)||n<0||n>3))throw new Error('--indexes accepts integers 0..3');
  if(!Number.isFinite(options.seconds)||options.seconds<10||options.seconds>120)throw new Error('--seconds accepts 10..120');
  if(!Number.isFinite(options.fps)||options.fps<1||options.fps>60)throw new Error('--fps accepts 1..60');
  return options;
}
module.exports={parseArgs};
