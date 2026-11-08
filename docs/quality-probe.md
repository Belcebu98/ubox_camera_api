# Registro de camaras y verificacion de stream — changes_funcionality9

La sonda ahora recuerda las camaras detectadas y comprueba si una UID esta enviando video antes de medir calidad. No activa RTSP, no cambia `recording_stream_index` ni modifica grabaciones.

## Registro local

`data/cameras.json` guarda UID, primera/ultima deteccion, origen y resultado del ultimo chequeo de stream. Esta excluido de Git y no guarda credenciales, tokens ni cookies.

```json
{
  "schemaVersion": 1,
  "cameras": [
    {
      "uid": "UID_REAL",
      "firstSeenAt": "2026-11-04T18:59:00Z",
      "lastSeenAt": "2026-11-04T18:59:00Z",
      "lastStreamCheckAt": "2026-11-04T18:59:10Z",
      "lastStreamActive": true,
      "source": "active-session"
    }
  ]
}
```

## Seleccion de UID

Orden: `--uid`; UID de una sesion activa; ultima camara guardada; unica camara de `device_list`. Con varias camaras guardadas, sin sesion activa y sin `--uid`, la sonda se detiene para evitar elegir la camara equivocada.

## Verificacion de stream

Antes de probar indices, la sonda abre brevemente el indice 0 y espera hasta 10 segundos. Considera el stream activo solo si recibe al menos un fotograma H.264 y el ultimo llego hace menos de 5 segundos.

```json
{
  "uid": "UID_REAL",
  "streamActive": true,
  "frames": 42,
  "format": "h264",
  "lastFrameAgeMs": 120,
  "meaning": "Camera sent at least one H.264 picture frame during the check"
}
```

Si no recibe fotogramas, escribe `streamActive: false`, no prueba calidad y guarda el resultado. Esto confirma recepcion de video en esa comprobacion; no garantiza continuidad futura, calidad, audio ni ausencia de cortes posteriores.

## Ejecucion

```powershell
node tools/quality-probe.js --indexes 0,1,2,3 --seconds 25
```

`--uid` sigue disponible para forzar una camara concreta. La sonda no aumenta resolucion, no cambia grabacion y no reenvia RTSP.
