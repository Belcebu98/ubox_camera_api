'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Transform, pipeline } = require('node:stream');
const ffmpeg = require('ffmpeg-static');
const states = new Map();
let enabled = true;
const error = (status, message) => Object.assign(new Error(message), { status });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function event(name, detail) { global.liveStreams?.emit(name, detail); }
function nalUnits(frame) {
  const starts = [];
  for (let i = 0; i + 3 <= frame.length; i++) {
    if (frame[i] || frame[i + 1]) continue;
    const length = frame[i + 2] === 1 ? 3 : frame[i + 2] === 0 && frame[i + 3] === 1 ? 4 : 0;
    if (length) { starts.push([i, length]); i += length - 1; }
  }
  return starts.map(([offset, size], index) => frame.subarray(offset + size, starts[index + 1]?.[0] ?? frame.length)).filter(nal => nal.length);
}
class Frames extends Transform {
  constructor(format) { super(); this.format = format; this.pending = Buffer.alloc(0); this.params = new Map(); this.ready = false; }
  _transform(chunk, encoding, done) {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4) {
        const length = this.pending.readUInt32BE(0);
        if (!length || length > 8 * 1024 * 1024) throw new Error('Invalid prefixed frame size');
        if (this.pending.length < length + 4) break;
        const frame = this.pending.subarray(4, length + 4); this.pending = this.pending.subarray(length + 4);
        const nals = nalUnits(frame); const hevc = this.format === 'hevc';
        const types = nals.map(nal => hevc ? (nal[0] >> 1) & 63 : nal[0] & 31);
        const required = hevc ? [32, 33, 34] : [7, 8];
        nals.forEach((nal, i) => { if (required.includes(types[i])) this.params.set(types[i], Buffer.from(nal)); });
        if (!this.ready) {
          const key = types.some(type => hevc ? [19, 20, 21].includes(type) : type === 5);
          if (!key || !required.every(type => this.params.has(type))) continue;
          this.ready = true;
          for (const type of required) this.push(Buffer.concat([Buffer.from([0, 0, 0, 1]), this.params.get(type)]));
        }
        this.push(frame);
      }
      done();
    } catch (err) { done(err); }
  }
  _flush(done) { done(this.pending.length ? new Error('Truncated prefixed frame') : undefined); }
}
function currentSession() { return global.liveStreams?.session; }
async function dispose(state) {
  if (state.stopping) return state.stopping;
  state.closed = true;
  state.stopping = (async () => {
    state.request?.destroy(); state.response?.destroy(); state.decoder?.destroy();
    if (states.get(state.track) === state) states.delete(state.track);
    if (state.proc && state.proc.exitCode === null && state.proc.signalCode === null) {
      const exited = new Promise(resolve => state.proc.once('close', resolve));
      state.proc.kill('SIGTERM');
      await Promise.race([exited, sleep(1000)]);
      if (state.proc.exitCode === null && state.proc.signalCode === null) state.proc.kill('SIGKILL');
      await Promise.race([exited, sleep(1000)]);
    }
    if (state.dir) await fsp.rm(state.dir, { recursive: true, force: true }).catch(() => {});
  })();
  return state.stopping;
}
async function launch(state) {
  try {
    if (!ffmpeg) throw new Error('ffmpeg-static binary unavailable');
    const format = state.session.streamFormat;
    if (!['h264', 'hevc'].includes(format)) throw error(409, 'Wait for the camera codec to be detected');
    const fps = Number(process.env.hls_fps || 15);
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw error(500, 'hls_fps must be 1..60');
    state.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ubox-hls-'));
    if (state.closed) throw error(409, 'HLS start cancelled');
    const args = ['-hide_banner', '-loglevel', 'warning', '-fflags', '+genpts+discardcorrupt', '-f', format, '-r', String(fps), '-i', 'pipe:0', '-an',
      '-vf', `setpts=N/(${fps}*TB),scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-bf', '0', '-r', String(fps), '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6', '-hls_flags', 'delete_segments+independent_segments+temp_file',
      '-hls_base_url', `/api/stream/hls/${state.track}/`, '-hls_segment_filename', path.join(state.dir, 'seg_%d.ts'), '-y', path.join(state.dir, 'index.m3u8')];
    const proc = state.proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    proc.on('error', err => { state.failure = err.message; });
    proc.stdin.on('error', err => { state.failure ||= err.message; });
    proc.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk.toString()).slice(-12000); });
    proc.on('close', (code, signal) => {
      if (!state.closed) { state.failure ||= `FFmpeg exited (${code}, ${signal})`; event('hls-process-exit', { track: state.track, code, signal, stderr: state.stderr }); }
    });
    state.decoder = new Frames(format);
    const source = `http://127.0.0.1:${process.env.server_port || 3000}/api/stream/live.h264?track=${state.track}`;
    state.request = http.get(source, response => {
      state.response = response;
      if (response.statusCode !== 200 || response.headers['x-stream-format'] !== 'uint32be-length-prefixed-annexb-h264') {
        state.failure = `Unexpected stream source: HTTP ${response.statusCode}`; response.destroy(); return;
      }
      response.setTimeout(15000, () => response.destroy(new Error('Video source idle for 15 seconds')));
      pipeline(response, state.decoder, proc.stdin, err => { if (!state.closed) state.failure = err?.message || 'Video source ended'; });
    });
    state.request.on('error', err => { state.failure = err.message; });
    event('hls-process-start', { track: state.track, format, fps, mode: 'transcode' });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (state.closed || currentSession() !== state.session) throw error(409, 'Camera session changed');
      if (state.failure) throw error(502, state.failure);
      const playlist = await fsp.readFile(path.join(state.dir, 'index.m3u8'), 'utf8').catch(() => '');
      if (playlist.includes('#EXTINF:')) return state;
      await sleep(150);
    }
    throw error(504, 'No HLS segments after 20 seconds; waiting for parameters/keyframe or encoder output');
  } catch (err) {
    event('hls-start-error', { track: state.track, message: err.message, stderr: state.stderr });
    await dispose(state); throw err;
  }
}
async function ensure(track) {
  if (!enabled) throw error(503, 'HLS disabled');
  if (!['primary', 'secondary'].includes(track)) throw error(400, 'Invalid track');
  const session = currentSession();
  if (!session) throw error(409, 'Start the camera first');
  if (!session.h264Tracks?.get(track)?.frames) throw error(409, `No frames on ${track}; try primary or wait for video`);
  let state = states.get(track);
  if (state && (state.session !== session || state.closed || state.failure)) { await dispose(state); state = null; }
  if (!state) {
    state = { track, session, lastAccess: Date.now(), stderr: '', closed: false };
    states.set(track, state); state.ready = launch(state);
  }
  state.lastAccess = Date.now(); return state.ready;
}
function isHlsRequest(route) { return route === '/api/stream/live.m3u8' || route.startsWith('/api/stream/hls/'); }
async function handleHlsRequest(req, res, url) {
  try {
    let state, filename, type;
    if (url.pathname === '/api/stream/live.m3u8') {
      state = await ensure(url.searchParams.get('track') || 'primary'); filename = 'index.m3u8'; type = 'application/vnd.apple.mpegurl';
    } else {
      const match = /^\/api\/stream\/hls\/(primary|secondary)\/(seg_\d+\.ts)$/.exec(url.pathname);
      if (!match) throw error(400, 'Invalid HLS segment');
      state = states.get(match[1]); filename = match[2]; type = 'video/mp2t';
      if (!enabled || !state || state.closed || state.failure || state.session !== currentSession()) throw error(404, 'HLS session not available');
    }
    state.lastAccess = Date.now();
    const content = await fsp.readFile(path.join(state.dir, filename));
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': content.length }); res.end(content);
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(err.code === 'ENOENT' ? 404 : err.status || 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: err.message }));
  }
}
async function shutdownAll() { await Promise.all([...states.values()].map(dispose)); }
function enableHls() { enabled = true; }
async function disableHls() { enabled = false; await shutdownAll(); }
function getStatus() { return { enabled, tracks: [...states.values()].map(s => ({ track: s.track, ready: Boolean(s.decoder?.ready), error: s.failure || null })) }; }
const sweep = setInterval(() => {
  for (const state of states.values()) if (state.session !== currentSession() || state.failure || Date.now() - state.lastAccess > 30000) dispose(state).catch(() => {});
}, 5000); sweep.unref();
process.on('exit', () => { for (const state of states.values()) state.proc?.kill('SIGKILL'); });
module.exports = { isHlsRequest, handleHlsRequest, enableHls, disableHls, isHlsEnabled: () => enabled, shutdownAll, getStatus, Frames, nalUnits };
