const http = require('http');
const fs = require('fs/promises');
const path = require('path');

require('dotenv').config();

const { GETrequest, POSTrequest, LOGINrequest } = require('./src/main/requests');
const { logDebug, makeUbiaRequest, hoursAgo } = require('./src/main/helpers');
const { UBoxLiveStreamManager } = require('./src/stream/ubox-live-stream');

const STORED_LOGIN_PATH = path.join(process.cwd(), '.storedLogin.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEBUG_MODE = process.env.debug_mode === 'true';

const state = {
  user: null,
  liveStreams: new UBoxLiveStreamManager({
    dumpDir: path.join(__dirname, 'stream-dumps'),
    logDir: path.join(__dirname, 'stream-logs'),
    enableSessionLogs: DEBUG_MODE,
    enableDumpFiles: DEBUG_MODE,
  }),
};

// Permite que requests.js siga funcionando sin reescribir todo ahora.
global.userdata = null;
global.liveStreams = state.liveStreams;

async function readStoredLogin() {
  try {
    const raw = await fs.readFile(STORED_LOGIN_PATH, 'utf8');
    const data = JSON.parse(raw);

    const valid =
      data?.file_created_by_ubox_camera_api === 1 &&
      data?.login_time &&
      typeof data?.token_valid_hours === 'number';

    if (!valid) return null;

    if (hoursAgo(data.login_time) >= data.token_valid_hours) return null;

    return data;
  } catch {
    return null;
  }
}

async function saveLogin(credentials) {
  await fs.writeFile(STORED_LOGIN_PATH, JSON.stringify(credentials, null, 2));
}

async function removeStoredLogin() {
  try {
    await fs.unlink(STORED_LOGIN_PATH);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(error);
  }
}

async function performLogin() {
  const credentials = await LOGINrequest();
  state.user = credentials;
  global.userdata = credentials;

  if (!(await checkLoginValidity())) {
    throw new Error('Login completed but session validation failed.');
  }

  await saveLogin(credentials);
  console.log('Login succeeded; credentials saved.');
  return credentials;
}

async function checkLoginValidity() {
  try {
    const response = await makeUbiaRequest({}, '/api/v2/user/device_list');
    return response?.code === 0 || response?.code === '0';
  } catch {
    return false;
  }
}

async function initializeLogin() {
  const stored = await readStoredLogin();

  if (stored) {
    state.user = stored;
    global.userdata = stored;

    if (await checkLoginValidity()) {
      console.log('Loaded valid stored login.');
      return;
    }

    await removeStoredLogin();
  }

  console.log('Logging in...');
  await performLogin();
}

async function ensureValidSession() {
  if (await checkLoginValidity()) return true;

  console.log('Session expired; re-login...');
  await removeStoredLogin();
  state.user = null;
  global.userdata = null;

  try {
    await performLogin();
    return true;
  } catch (error) {
    console.error('Re-login failed:', error.message);
    return false;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function serveStatic(res, filePath, contentType) {
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  logDebug('Request', { method: req.method, pathname });

  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  if (!state.user?.token) {
    return sendJson(res, 401, { error: 'Not yet logged in' });
  }

  // HLS debe pasar directo: puede recibir múltiples peticiones de segmentos.
  if (pathname.includes('/api/stream/hls')) {
    if (req.method === 'GET') return GETrequest(req, res);
    if (req.method === 'POST') return POSTrequest(req, res);
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const validSession = await ensureValidSession();
  if (!validSession) {
    return sendJson(res, 503, { error: 'Authentication unavailable' });
  }

  if (req.method === 'GET') return GETrequest(req, res);
  if (req.method === 'POST') return POSTrequest(req, res);

  return sendJson(res, 405, { error: 'Method not allowed' });
}

function startServer() {
  const port = Number(process.env.server_port) || 3000;

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      console.error('Unhandled request error:', error);

      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Internal server error' });
      } else {
        res.end();
      }
    }
  });

  server.listen(port, () => {
    console.log(`UBox Camera API running: http://localhost:${port}`);
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down...`);

    server.close(async () => {
      try {
        await state.liveStreams.stop?.();
      } catch (error) {
        console.error(error);
      }
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
  });
}

(async () => {
  try {
    await initializeLogin();
    startServer();
  } catch (error) {
    console.error('Fatal startup error:', error);
    process.exit(1);
  }
})();