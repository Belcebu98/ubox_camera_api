'use strict';

const grid = document.getElementById('grid');
const statusEl = document.getElementById('recorder-status');
const errorEl = document.getElementById('error');

async function getJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function firstValue(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function normalizeCamera(item, info) {
  const merged = { ...(info || {}), ...(item || {}) };
  return {
    uid: firstValue(merged, ['device_uid', 'uid']),
    name: firstValue(merged, ['name', 'device_name', 'alias', 'nickname']) || 'Cámara',
    battery: firstValue(merged, ['battery', 'battery_percent', 'batteryLevel']),
    online: firstValue(merged, ['online', 'is_online', 'status']),
    raw: merged,
  };
}

function cameraList(payload) {
  const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
  const infos = Array.isArray(payload?.data?.infos) ? payload.data.infos : [];
  const byUid = new Map();
  for (const info of infos) {
    const uid = firstValue(info, ['device_uid', 'uid']);
    if (uid) byUid.set(uid, normalizeCamera(null, info));
  }
  for (const item of items) {
    const uid = firstValue(item, ['device_uid', 'uid']);
    if (!uid) continue;
    byUid.set(uid, normalizeCamera(item, byUid.get(uid)?.raw));
  }
  return [...byUid.values()].filter(camera => camera.uid);
}

function badge(text, className = '') {
  return `<span class="badge ${className}">${text}</span>`;
}

function render(cameras, activeUid, recorderStatus) {
  grid.innerHTML = '';
  if (!cameras.length) {
    grid.innerHTML = '<div class="camera">No se han encontrado cámaras en la cuenta UBox.</div>';
    return;
  }
  for (const camera of cameras) {
    const active = camera.uid === activeUid;
    const card = document.createElement('article');
    card.className = `camera${active ? ' active' : ''}`;
    const battery = camera.battery === '' ? '' : badge(`Batería: ${camera.battery}`, Number(camera.battery) <= 20 ? 'bad' : 'ok');
    card.innerHTML = `
      <h2>${camera.name}</h2>
      <div class="uid">UID: ${camera.uid}</div>
      <div class="meta">
        ${active ? badge('Grabando', 'ok') : badge('Disponible')}
        ${battery}
      </div>
      <button type="button" ${active ? 'disabled' : ''}>${active ? 'Cámara activa' : 'Grabar esta cámara'}</button>
    `;
    card.querySelector('button').addEventListener('click', async () => {
      const button = card.querySelector('button');
      button.disabled = true;
      button.textContent = 'Cambiando…';
      errorEl.textContent = '';
      try {
        await fetch('/api/nvr/select-camera', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uid: camera.uid }),
        }).then(async response => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        });
        await refresh();
      } catch (error) {
        errorEl.textContent = error.message;
        button.disabled = false;
        button.textContent = 'Grabar esta cámara';
      }
    });
    grid.append(card);
  }

  const receiving = recorderStatus?.receiving ? 'recibiendo vídeo' : 'sin vídeo';
  const recording = recorderStatus?.recording ? 'grabando' : 'no grabando';
  statusEl.textContent = `Cámara activa: ${activeUid || 'ninguna'} · ${receiving} · ${recording}`;
}

async function refresh() {
  try {
    const [camerasPayload, recorderStatus] = await Promise.all([
      getJson('/api/nvr/cameras'),
      getJson('/api/nvr/status'),
    ]);
    render(cameraList(camerasPayload), recorderStatus?.camera || null, recorderStatus);
    errorEl.textContent = '';
  } catch (error) {
    errorEl.textContent = `No se pudo actualizar el panel: ${error.message}`;
  }
}

refresh();
setInterval(refresh, 5000);
