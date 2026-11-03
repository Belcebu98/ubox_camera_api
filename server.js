'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config();
const { GETrequest, POSTrequest, LOGINrequest } = require('./src/main/requests');
const { makeUbiaRequest } = require('./src/main/helpers');
const hls = require('./src/main/h264-hls');
const { UBoxLiveStreamManager } = require('./src/stream/ubox-live-stream');
const port = Number(process.env.server_port || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server_port');
process.env.server_port = String(port);
const manager = global.liveStreams = new UBoxLiveStreamManager({
  dumpDir: path.join(__dirname, 'stream-dumps'), logDir: path.join(__dirname, 'stream-logs'),
  enableSessionLogs: process.env.stream_log_file !== 'false',
  enableDumpFiles: process.env.stream_dump_video === 'true',
});
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /password|token|cookie|authorization|prefix|^loginId$|^loginPwd$/i.test(key) ? '[REDACTED]' : redact(item)]));
}
const emit = manager.emit.bind(manager);
manager.emit = (event, detail = {}) => {
  const row = emit(event, redact(detail));
  if (process.env.stream_log_console === 'true') console.log(JSON.stringify(row));
  return row;
};
const writeLog = manager.writeSessionLog.bind(manager);
manager.writeSessionLog = row => writeLog(redact(row));
let loginPromise = null;
function validAge(user) {
  const age = Date.now() - Date.parse(user?.login_time);
  const ttl = Number(user?.token_valid_hours) * 3600000;
  return Boolean(user?.token) && Number.isFinite(age) && age >= 0 && Number.isFinite(ttl) && ttl > age;
}
async function login() {
  if (!loginPromise) loginPromise = LOGINrequest().then(user => {
    if (!user?.token) throw new Error('Login response has no token');
    global.userdata = user;
  }).finally(() => { loginPromise = null; });
  return loginPromise;
}
async function initialize() {
  try {
    const user = JSON.parse(await fs.readFile(path.join(__dirname, '.storedLogin.json'), 'utf8'));
    if (validAge(user)) {
      global.userdata = user;
      const response = await makeUbiaRequest({}, '/api/v2/user/device_list');
      if (response?.code === 0 || response?.code === '0') return;
      if (Number(response?.code) >= 500) throw new Error('UBox unavailable; stored session preserved');
    }
  } catch (error) {
    if (error.message === 'UBox unavailable; stored session preserved') throw error;
    if (error.code && error.code !== 'ENOENT') throw error;
  }
  await login();
}
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
let shuttingDown = false;
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let pathname = '';
  res.on('finish', () => console.log(JSON.stringify({ at: new Date().toISOString(), event: 'http-response', method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - started })));
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
    if (shuttingDown) return json(res, 503, { error: 'Server shutting down' });
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST'); return json(res, 405, { error: 'Method not allowed' });
    }
    if (req.method === 'GET' && ['/', '/index.html'].includes(pathname)) {
      const body = await fs.readFile(path.join(__dirname, 'public/index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(body);
    }
    if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    // Local delivery must not make cloud requests on every segment or status poll.
    if ((!pathname.startsWith('/api/stream/') || pathname === '/api/stream/start') && !validAge(global.userdata)) await login();
    return await (req.method === 'GET' ? GETrequest(req, res) : POSTrequest(req, res));
  } catch (error) {
    console.error('[HTTP]', error.message);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    else res.destroy();
  }
});
server.on('error', error => { console.error('[SERVER]', error.message); shutdown(1); });
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const timeout = setTimeout(() => process.exit(1), 8000); timeout.unref();
  manager.restartSession = () => {};
  const closed = new Promise(resolve => server.close(resolve));
  try { await hls.shutdownAll(); await manager.stop(); }
  catch (error) { console.error('[SHUTDOWN]', error.message); }
  manager.closeSessionLog();
  for (const client of manager.sseClients) client.end();
  server.closeIdleConnections?.();
  await closed; clearTimeout(timeout); process.exit(code);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('unhandledRejection', error => { console.error('[FATAL]', error); shutdown(1); });
process.on('uncaughtException', error => { console.error('[FATAL]', error); shutdown(1); });
initialize().then(() => server.listen(port, process.env.server_host || '127.0.0.1', () => {
  console.log(`UBox: http://localhost:${port} | events: ${manager.logDir}`);
})).catch(error => { console.error('[STARTUP]', error.message); process.exitCode = 1; });
