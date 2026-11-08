'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseSpsDimensions}=require('../src/stream/sps');
const {parseArgs}=require('../tools/quality-probe-args.js');
test('returns finite non-negative dimensions for a structurally valid SPS',()=>{const dimensions=parseSpsDimensions(Buffer.from('6742c028dca5e082a000002d9c80','hex'));assert.ok(Number.isInteger(dimensions.width)&&dimensions.width>=0);assert.ok(Number.isInteger(dimensions.height)&&dimensions.height>=0);});
test('does not throw on malformed SPS',()=>{const malformed=parseSpsDimensions(Buffer.from([0x67,0x42]));assert.ok(Number.isFinite(malformed.width)&&Number.isFinite(malformed.height));});
test('validates probe arguments and defaults',()=>{const options=parseArgs(['--indexes','0,2','--seconds','20','--uid','CAM_A']);assert.deepEqual(options.indexes,[0,2]);assert.equal(options.seconds,20);assert.equal(options.uid,'CAM_A');assert.throws(()=>parseArgs(['--indexes','4']),/0\.\.3/);assert.throws(()=>parseArgs(['--seconds','5']),/10\.\.120/);});
