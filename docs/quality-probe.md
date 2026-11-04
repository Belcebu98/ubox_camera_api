# Sonda de calidad de video — changes_funcionality9

Esta herramienta mide lo que entrega cada indice de stream de la camara. No aumenta la resolucion, no cambia `recording_stream_index`, no activa RTSP/Frigate y no modifica grabaciones existentes.

## Ejecucion

Deten el grabador antes de probar. Desde la raiz del proyecto:

```powershell
node tools/quality-probe.js --indexes 0,1,2,3 --seconds 25 --uid UID_REAL
```

Si la cuenta tiene exactamente una camara, `--uid` es opcional. Duracion admitida por indice: 10–120 segundos. Salida por defecto:

```text
data/diagnostics/quality-probe/
  stream-0.mp4
  stream-0.json
  stream-1.mp4
  stream-1.json
  ...
  quality-report.json
```

Puedes limitar la prueba:

```powershell
node tools/quality-probe.js --indexes 0,1 --seconds 20
```

## Resultados

Cada `stream-N.json` incluye:

- `width` y `height`: dimensiones declaradas en SPS H.264.
- `measuredFps`: fotogramas recibidos por segundo durante la prueba.
- `videoBitrateKbps`: bytes de video por segundo.
- `frames`, `keyframes` y `gaps`: volumen y continuidad.
- `sampleFile`: MP4 corto para comparacion visual.
- `measurement`: siempre `camera-stream-frame-count`.

`quality-report.json` propone el indice con mayor `resolucion x FPS medido`, pero esa sugerencia no cambia la configuracion. Compara los MP4 antes de decidir: un indice puede tener mas resolucion nominal pero mas huecos, menos FPS reales o peor imagen.

## Limites importantes

- La sonda no puede crear detalle ni subir la resolucion nativa de la camara.
- Un indice mayor no garantiza HD; puede ser un substream o no estar disponible.
- `measuredFps` es tasa de recepcion en una prueba corta, no un ajuste garantizado de la camara.
- La resolucion procede de SPS y puede reflejar dimensiones codificadas o recortadas.
- La sonda no decodifica cada fotograma ni mide nitidez, exposicion ni calidad subjetiva.
- No ejecutes la sonda mientras el grabador este usando la misma camara: pueden competir por la sesion.
- La herramienta es solo diagnostico; no integra audio G.726 ni reenvia RTSP.

## Despues de la prueba

Revisa el MP4 de cada indice y elige el mejor equilibrio entre detalle, FPS real, bitrate y estabilidad. Solo despues cambia manualmente `recording_stream_index` en `.env`, reinicia el servicio y verifica un tramo completo. El siguiente paso, RTSP para Frigate, usara el indice elegido y transcodificara G.726 a AAC; no esta implementado en esta entrega.
