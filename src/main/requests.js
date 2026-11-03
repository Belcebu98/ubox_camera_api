const fs = require('fs/promises');
const axios = require('axios');
const path = require('path');

const {
  makeUbiaRequest,
  hmacSha1Base64,
  generateRandomString,
  logDebug,
  json,
  readBody,
  writeUbiaJsonResponse,
  setRtspEnabled,
  hoursAgo,
} = require('./helpers.js');

const { isHlsRequest, handleHlsRequest } = require('./h264-hls.js');
require('./h264-rtsp.js');

setRtspEnabled(false);

const STORED_LOGIN_PATH = path.join(process.cwd(), '.storedLogin.json');

async function GETrequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  if (isHlsRequest(pathname)) {
    return handleHlsRequest(req, res, url);
  }

  switch (pathname) {
    case '/api/v2/user/device_list': {
      const response = await makeUbiaRequest({}, pathname, global.userdata?.token);
      return writeUbiaJsonResponse(res, response);
    }

    case '/api/user/families': {
      const response = await makeUbiaRequest(
        { token: global.userdata?.token },
        pathname,
        global.userdata?.token
      );
      return writeUbiaJsonResponse(res, response);
    }

    case '/api/user/get_subscription_ios_device': {
      const response = await makeUbiaRequest({}, pathname, global.userdata?.token);
      return writeUbiaJsonResponse(res, response);
    }

    case '/api/stream/status':
      return json(res, 200, {
        ...global.liveStreams.status(),
        events: global.liveStreams.recentEvents(80),
      });

    case '/api/stream/events':
      return global.liveStreams.addSseClient(res);

    case '/api/stream/live.h264': {
      if (!global.liveStreams?.addH264Client) {
        return json(res, 503, { error: 'Live stream manager is not available.' });
      }

      return global.liveStreams.addH264Client(
        res,
        url.searchParams.get('track') || 'primary'
      );
    }

    case '/api/login/expires_in': {
      const hoursSinceLogin = hoursAgo(global.userdata.login_time);

      return json(res, 200, {
        hours_since_login: hoursSinceLogin,
        token_valid_for: global.userdata.token_valid_hours,
      });
    }

    default:
      return json(res, 404, { error: 'Not found' });
  }
}

async function POSTrequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  let parsedBody;

  try {
    parsedBody = await readBody(req);
  } catch (error) {
    return json(res, 400, { error: error.message });
  }

  parsedBody.token = global.userdata?.token;

  switch (pathname) {
    case '/api/user/qry/device/device_services':
    case '/api/user/cloud_list': {
      const response = await makeUbiaRequest(
        parsedBody,
        pathname,
        global.userdata?.token
      );
      return writeUbiaJsonResponse(res, response);
    }

    case '/api/stream/start': {
      setRtspEnabled(true);

      if (!parsedBody.device && !parsedBody.uid) {
        return json(res, 400, { error: 'device or uid is required.' });
      }

      const requestedStreamIndex =
        parsedBody.streamIndex ?? parsedBody.options?.streamIndex;

      let device;

      if (parsedBody.device) {
        device = {
          ...parsedBody.device,
          ...(requestedStreamIndex !== undefined
            ? { streamIndex: requestedStreamIndex }
            : {}),
        };
      } else {
        const response = await makeUbiaRequest(
          {},
          '/api/v2/user/device_list',
          global.userdata?.token
        );

        const items = Array.isArray(response?.data?.items)
          ? response.data.items
          : [];

        const infos = Array.isArray(response?.data?.infos)
          ? response.data.infos
          : [];

        const matched = items.find(
          (item) => item?.device_uid === parsedBody.uid || item?.uid === parsedBody.uid
        );

        const matchedInfo = infos.find(
          (item) => item?.device_uid === parsedBody.uid || item?.uid === parsedBody.uid
        );

        if (!matched?.device_uid && !matched?.uid) {
          return json(res, 404, { error: `Device ${parsedBody.uid} not found.` });
        }

        device = {
          uid: matched.device_uid ?? matched.uid,
          name: matched.device_name,
          owner: matched.is_owner,
          source: 'infos',
          raw: matchedInfo,
          ...(requestedStreamIndex !== undefined
            ? { streamIndex: requestedStreamIndex }
            : {}),
        };
      }

      const options = {
        ...(parsedBody.options || {}),
        ...(requestedStreamIndex !== undefined
          ? { streamIndex: requestedStreamIndex }
          : {}),
      };

      const status = await global.liveStreams.start(device, options);
      return json(res, 200, status);
    }

    case '/api/stream/stop': {
      setRtspEnabled(false);
      await global.liveStreams?.stop?.();
      return json(res, 200, global.liveStreams?.status?.() || { state: 'stopped' });
    }

    case '/api/stream/decode-packet': {
      if (!parsedBody.hex) {
        return json(res, 400, { error: 'hex is required.' });
      }

      return json(res, 200, global.liveStreams.decodePacket(parsedBody.hex));
    }

    default:
      return json(res, 404, { error: 'Not found' });
  }
}

async function LOGINrequest() {
  const email = process.env.email;
  const rawPassword = process.env.password;

  if (!email || !rawPassword) {
    throw new Error('Missing email or password environment variables.');
  }

  const body = {
    account: email,
    password: hmacSha1Base64(rawPassword),
    lang: 'en',
    app: 'ubox',
    device_token: generateRandomString(30),
    device_type: 2,
  };

  const response = await axios.post(
    'https://portal.ubianet.com/api/v3/login',
    body,
    {
      timeout: 15_000,
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
      },
    }
  );

  const data = response.data;

  if (data?.code !== 0) {
    throw new Error(`UBox login failed: ${data?.msg ?? 'unknown error'}`);
  }

  const tokenInfo = {
    token: data.data.Token,
    uuid: data.data.uuid,
    token_valid_hours: data.data.token_valid_hours,
    kuid: data.data.kuid,
    login_time: new Date().toISOString(),
    file_created_by_ubox_camera_api: 1,
  };

  global.userdata = tokenInfo;
  await fs.writeFile(STORED_LOGIN_PATH, JSON.stringify(tokenInfo, null, 2));

  return tokenInfo;
}

module.exports = {
  GETrequest,
  POSTrequest,
  LOGINrequest,
};