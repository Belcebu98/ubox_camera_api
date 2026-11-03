'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Frames } = require('../src/main/h264-hls');
const nal = (...bytes) => Buffer.from([0, 0, 0, 1, ...bytes]);
const packet = frame => { const size = Buffer.alloc(4); size.writeUInt32BE(frame.length); return Buffer.concat([size, frame]); };
async function decode(format, data, fragmented = false) {
  const stream = new Frames(format); const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  const finished = once(stream, 'end');
  if (fragmented) for (const byte of data) stream.write(Buffer.from([byte]));
  else stream.write(data);
  stream.end(); await finished; return Buffer.concat(chunks);
}
test('H264 strips split length prefixes and waits for SPS/PPS plus IDR', async () => {
  const sps = nal(0x67, 0x64, 0, 0x16), pps = nal(0x68, 0xce), delta = nal(0x41, 0x12), key = nal(0x65, 0x88);
  const input = Buffer.concat([packet(delta), packet(sps), packet(pps), packet(key), packet(delta)]);
  assert.deepEqual(await decode('h264', input, true), Buffer.concat([sps, pps, key, delta]));
});
test('HEVC waits for VPS/SPS/PPS and random access frame', async () => {
  const params = [nal(64, 1), nal(66, 1), nal(68, 1)], key = nal(38, 1, 42);
  assert.deepEqual(await decode('hevc', Buffer.concat([...params, key].map(packet))), Buffer.concat([...params, key]));
});
test('rejects oversized frames', async () => {
  const invalid = Buffer.alloc(4); invalid.writeUInt32BE(9 * 1024 * 1024);
  await assert.rejects(decode('h264', invalid), /Invalid prefixed/);
});
test('rejects incomplete frames at EOF', async () => {
  await assert.rejects(decode('h264', Buffer.from([0, 0, 0, 10, 1])), /Truncated/);
});
