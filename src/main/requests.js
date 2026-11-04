'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const axios = require('axios');
const { makeUbiaRequest, hmacSha1Base64, generateRandomString, json, writeUbiaJsonResponse, hoursAgo } = require('./helpers');
const hls = require('./h264-hls');
const quality = require('./stream-quality');
const qualityApi = require('./stream-quality-api');
// RTSP is intentionally not imported: this web-focused revision disables its auto-start race.
const storedLogin = path.resolve(__dirname, '../../.storedLogin.json');
const fail = (status, message) => Object.assign(new Error(message), { status });
let operation = Promise.resolve();
function serialize(action) {
  const next = operation.then(action); operation = next.catch(() => {}); return next;
}
async function body(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 524288) throw fail(413, 'JSON body exceeds 512 KiB');
    chunks.push(chunk);
  }
  let value;
  try { const raw = Buffer.concat(chunks).toString('utf8'); value = raw ? JSON.parse(raw) : {}; }
  catch { throw fail(400, 'Invalid JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw fail(400, 'JSON object required');
  return value;
}
async function GETrequest(req, res) {
  const url = new URL(req.url, 'http://localhost'); const route = url.pathname;
  if (route === '/api/cameras/streams') return json(res, 200, await qualityApi.handle('GET', route, Object.fromEntries(url.searchParams), global.liveStreams));
  if (hls.isHlsRequest(route)) return hls.handleHlsRequest(req, res, url);
  switch (route) {
    case '/api/v2/user/device_list':
    case '/api/user/get_subscription_ios_device':
      return writeUbiaJsonResponse(res, await makeUbiaRequest({}, route));
    case '/api/user/families':
      return writeUbiaJsonResponse(res, await makeUbiaRequest({ token: global.userdata?.token }, route));
    case '/api/stream/status':
      return json(res, 200, { ...global.liveStreams.status(), hls: hls.getStatus(), rtsp: { enabled: false, reason: 'Disabled in web-focused revision' }, events: global.liveStreams.recentEvents(80) });
    case '/api/stream/events': return global.liveStreams.addSseClient(res);
    case '/api/stream/live.h264': {
      const track = url.searchParams.get('track') || 'primary';
      if (!['primary', 'secondary'].includes(track)) throw fail(400, 'Invalid track');
      return global.liveStreams.addH264Client(res, track);
    }
    case '/api/login/expires_in':
      return json(res, 200, { hours_since_login: global.userdata?.login_time ? hoursAgo(global.userdata.login_time) : null, token_valid_for: global.userdata?.token_valid_hours ?? null });
    default: throw fail(404, 'Not found');
  }
}
async function POSTrequest(req, res) {
  const route = new URL(req.url, 'http://localhost').pathname;
  const data = await body(req);
  if (['/api/cameras/preferred-stream', '/api/cameras/quality-probe'].includes(route)) return json(res, 200, await qualityApi.handle('POST', route, data, global.liveStreams));
  if (qualityApi.isBusy() && route.startsWith('/api/stream/')) throw fail(409, 'Quality operation owns session');
  switch (route) {
    case '/api/user/qry/device/device_services':
    case '/api/user/cloud_list':
      return writeUbiaJsonResponse(res, await makeUbiaRequest({ ...data, token: global.userdata?.token }, route));
    case '/api/stream/start': return serialize(async () => {
      if (!global.userdata?.token) throw fail(503, 'UBox login unavailable');
      if (data.device !== undefined && (!data.device || Array.isArray(data.device) || typeof data.device !== 'object')) throw fail(400, 'device must be an object');
      if (data.options !== undefined && (!data.options || Array.isArray(data.options) || typeof data.options !== 'object')) throw fail(400, 'options must be an object');
      const explicitIndex = data.streamIndex ?? data.options?.streamIndex;
      if (explicitIndex !== undefined) { try { quality.index(explicitIndex); } catch (e) { throw fail(400, e.message); } }
      let device = data.device;
      if (!device) {
        if (typeof data.uid !== 'string' || !data.uid.trim()) throw fail(400, 'uid or device required');
        const response = await makeUbiaRequest({}, '/api/v2/user/device_list');
        if (![0, '0'].includes(response?.code)) throw fail(502, 'Unable to retrieve cameras from UBox');
        const items = Array.isArray(response?.data?.items) ? response.data.items : [];
        const infos = Array.isArray(response?.data?.infos) ? response.data.infos : [];
        const match = item => (item?.device_uid ?? item?.uid) === data.uid.trim();
        const item = items.find(match); const info = infos.find(match);
        if (!item && !info) throw fail(404, 'Camera not found');
        const raw = { ...item, ...info };
        device = { ...item, ...info, uid: data.uid.trim(), raw };
      }
      const uid = device.uid || device.device_uid || device.raw?.device_uid;
      if (typeof uid !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(uid)) throw fail(400, 'Invalid camera UID');
      const index = await quality.resolve(uid, explicitIndex);
      await hls.shutdownAll();
      const status = await global.liveStreams.start({ ...device, uid, streamIndex: index }, { ...data.options, streamIndex: index });
      return json(res, 200, status);
    });
    case '/api/stream/stop': return serialize(async () => {
      await hls.shutdownAll(); await global.liveStreams.stop();
      return json(res, 200, global.liveStreams.status());
    });
    case '/api/stream/decode-packet':
      if (typeof data.hex !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(data.hex) || data.hex.length > 131070) throw fail(400, 'hex must contain complete byte pairs, maximum 65535 bytes');
      return json(res, 200, global.liveStreams.decodePacket(data.hex));
    default: throw fail(404, 'Not found');
  }
}
async function LOGINrequest() {
  if (!process.env.email || !process.env.password) throw new Error('Missing email/password in .env');
  const response = await axios.post('https://portal.ubianet.com/api/v3/login', {
    account: process.env.email, password: hmacSha1Base64(process.env.password), lang: 'en', app: 'ubox',
    device_token: generateRandomString(30), device_type: 2,
  }, { timeout: 15000, headers: { 'Content-Type': 'application/json' } });
  const result = response.data;
  if (![0, '0'].includes(result?.code) || !result?.data?.Token) throw new Error('UBox login failed');
  const user = { token: result.data.Token, uuid: result.data.uuid, token_valid_hours: Number(result.data.token_valid_hours), kuid: result.data.kuid, login_time: new Date().toISOString(), file_created_by_ubox_camera_api: 1 };
  if (!Number.isFinite(user.token_valid_hours) || user.token_valid_hours <= 0) throw new Error('Invalid token validity');
  const temporary = storedLogin + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(user, null, 2), { mode: 0o600 });
  await fs.rename(temporary, storedLogin);
  global.userdata = user; return user;
}
module.exports = { GETrequest, POSTrequest, LOGINrequest };
