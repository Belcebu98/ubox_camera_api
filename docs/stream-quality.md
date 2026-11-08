# Selección de calidad por cámara

Base: 60feedf77e6a0611a196a926e9c54ee6b8305e1b; rama changes_funcionality1.

El almacén independiente data/stream-quality.json no contiene credenciales.
Se mantiene separado de CameraRegistry porque su cargador actual descarta
campos desconocidos. Las pruebas parciales conservan índices no probados;
un fallo conserva dimensiones históricas pero excluye ese índice de la
recomendación hasta una prueba nueva correcta. Una prueba no cambia modo manual.

Prioridad al arrancar el grabador:
1. Elección manual guardada.
2. Recomendación automática por ancho * alto * FPS entre resultados válidos.
3. recording_stream_index como respaldo, o 0.
Una variable de entorno existente deja de ser una orden absoluta si existe
selección guardada. La API legacy respeta streamIndex explícito numérico.

API:
GET /api/cameras/streams?uid=UID
POST /api/cameras/preferred-stream
  {"uid":"UID","selectionMode":"manual","streamIndex":1,"apply":true}
  {"uid":"UID","selectionMode":"auto","apply":false}
POST /api/cameras/quality-probe {"uid":"UID","seconds":30}

Guardar sin aplicar no reinicia la sesión. Aplicar y medir son exclusivos
en el servidor; pausan el temporizador, finalizan el tramo, detienen HLS/P2P
y al terminar intentan reanudar. La respuesta no garantiza recepción de vídeo:
consultar /api/nvr/status. En legacy no se permite aplicar inmediatamente y
se requiere detener manualmente el stream antes de medir.

La sonda guarda diagnósticos y muestras bajo:
data/diagnostics/quality-probe/UID/TIMESTAMP/
La ubicación exacta depende de --out. El JSON de stdout incluye calidad guardada.
Los resultados no se precargan con datos particulares de una cámara.

Limitaciones explícitas:
- No ejecutar otra sonda CLI simultánea al grabador. Exclusión HTTP por proceso.
- Un .lock residual después de una muerte abrupta requiere revisión manual;
  nunca se elimina un bloqueo automáticamente sin saber si hay un escritor vivo.
- La base existente puede reiniciar automáticamente una sesión durante la sonda;
  esta revisión no sustituye su mecanismo interno de observación de fotogramas.
- No se han probado relay, cámara, navegador ni Windows desde este entorno.
- El preparador ejecuta node --check sobre todos los JS generados y las nuevas
  pruebas unitarias; no equivale a ejecutar toda la suite del proyecto.
- No modifica reproducción, codecs ni el protocolo P2P.

Después de revisar y aplicar localmente: npm test, inicio del grabador, prueba
de cambio 0/1, prueba automática, caída de relay y cierre durante una sonda.
