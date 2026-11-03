const crypto = require('crypto');
const sha1 = require('js-sha1');
const axios = require('axios');

require('dotenv').config();

const UBIA_BASE_URL = 'https://portal.ubianet.com';
const MAX_JSON_BODY_BYTES = 512 * 1024;
const DEBUG_MODE = process.env.debug_mode === 'true';

function logDebug(message, data) {
  if (!DEBUG_MODE) return;
  console.log(`[DEBUG] ${message}`, data ?? '');
}

function redactHeaders(headers = {}) {
  const sensitive = ['authorization', 'cookie', 'x-ubia-auth-usertoken'];

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      sensitive.includes(key.toLowerCase()) ? '[REDACTED]' : value,
    ])
  );
}

function hmacSha1Base64(data) {
  const hash = sha1.hmac.array('', data);
  const base64 = Buffer.from(hash).toString('base64');

  // Requisito observado del protocolo UBox/Ubia.
  return `${base64.slice(0, -1)},`;
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function binary(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function generateRandomString(length = 32) {
  return crypto.randomBytes(Math.ceil(length * 0.75))
    .toString('base64url')
    .slice(0, length);
}

async function makeUbiaRequest(body, url, userToken) {
  const token = userToken ?? global.userdata?.token ?? '';

  const headers = {
    method: 'POST',
    scheme: 'https',
    path: url,
    authority: 'portal.ubianet.com',
    accept: '*/*',
    'content-type': 'application/json',
    'x-ubia-auth-usertoken': token,
  };

  logDebug('Ubia request', {
    url,
    bodyKeys: body && typeof body === 'object' ? Object.keys(body) : undefined,
    headers: redactHeaders(headers),
  });

  try {
    const response = await axios.post(`${UBIA_BASE_URL}${url}`, body, {
      headers,
      timeout: 15_000,
    });

    logDebug('Ubia response', {
      status: response.status,
      code: response.data?.code,
      msg: response.data?.msg,
    });

    return response.data;
  } catch (error) {
    if (error.response) {
      return {
        code: error.response.status,
        msg: error.response.data,
      };
    }

    if (error.request) {
      return { code: 504, msg: 'Ubia API did not respond' };
    }

    return { code: 500, msg: error.message };
  }
}

function readBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.destroy();
      reject(error);
    };

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > maxBytes) {
        fail(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;

      const raw = Buffer.concat(chunks).toString('utf8');

      if (!raw) return resolve({});

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', fail);
  });
}

function hoursAgo(dateValue) {
  const then = new Date(dateValue);

  if (Number.isNaN(then.getTime())) {
    throw new Error(`Invalid date: ${JSON.stringify(dateValue)}`);
  }

  return (Date.now() - then.getTime()) / (1000 * 60 * 60);
}

function normalizeUbiaStatusCode(code) {
  if (code === 0 || code === '0') return 200;

  const parsed = Number(code);

  if (Number.isInteger(parsed) && parsed >= 100 && parsed < 600) {
    return parsed;
  }

  return 502;
}

function writeUbiaJsonResponse(res, ubiaResponse) {
  const payload = ubiaResponse?.data !== undefined
    ? ubiaResponse.data
    : ubiaResponse;

  json(res, normalizeUbiaStatusCode(ubiaResponse?.code), payload);
}

function setRtspEnabled(enabled) {
  const rtsp = require('./h264-rtsp.js');
  return enabled ? rtsp.enableRtsp() : rtsp.disableRtsp();
}

function isRtspEnabled() {
  return require('./h264-rtsp.js').isRtspEnabled();
}

function setHlsEnabled(enabled) {
  const hls = require('./h264-hls.js');
  return enabled ? hls.enableHls() : hls.disableHls();
}

function isHlsEnabled() {
  return require('./h264-hls.js').isHlsEnabled();
}

module.exports = {
  hmacSha1Base64,
  generateRandomString,
  makeUbiaRequest,
  logDebug,
  json,
  text,
  binary,
  readBody,
  hoursAgo,
  normalizeUbiaStatusCode,
  writeUbiaJsonResponse,
  setRtspEnabled,
  isRtspEnabled,
  setHlsEnabled,
  isHlsEnabled,
};