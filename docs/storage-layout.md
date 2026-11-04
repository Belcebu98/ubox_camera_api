# Almacenamiento separado — changes_funcionality8

Esta guia sustituye los ejemplos de rutas antiguas del README hasta su actualizacion. La entrega no mueve ni borra videos, no descarga SD, no integra audio/PIR y no habilita multicamara simultanea.

Nuevos videos: recording_dir/continuo/UID/fecha/video.mp4. Detecciones: recording_dir/detecciones/UID/fecha/video.mp4 (reservado). JSON: metadata_dir/continuo|detecciones/UID/fecha/video.mp4.json. Logs: camera_logs_dir/UID/fecha/sesion.jsonl y app_logs_dir/fecha.jsonl.

Por defecto video en E:/camaras y estado en data/recordings, logs/cameras, logs/app, data/diagnostics y data/downloads bajo el proyecto. Rutas relativas de estado resueltas desde el proyecto; deben quedar fuera del destino de video, tambien tras resolver enlaces. No se introduce retencion ni rotacion por tamano.

Se siguen leyendo IDs antiguos UID/fecha/video.mp4 y nuevos continuo|detecciones/UID/fecha/video.mp4. GET /api/nvr/recordings?kind=all|continuo|detecciones filtra. El visor lista ambos; no incorpora nuevas pestanas. Un archivo en detecciones no acredita su origen ni una causa del sensor. metadataAvailable indica JSON compatible en el destino nuevo.

El MP4 se finaliza primero; el JSON se publica despues. Si falla el JSON se conservan MP4 y provisional y se registra error. No hay atomicidad entre discos ni recuperacion automatica. Para publicar JSON sin sobrescritura se usa temporal + enlace duro en el destino: el sistema de archivos de metadata debe soportarlo. Contenido identico es idempotente; distinto da conflicto sin reemplazarlo.

## Copia de metadatos antiguos

Deten Node. Con el mismo .env:

```powershell
node tools/migrate-recording-metadata.js
```

Simulacion: puede crear directorios vacios de destino, pero no copia JSON ni mueve videos.

```powershell
node tools/migrate-recording-metadata.js --apply
```

Copia JSON identificados, conserva originales, no mueve videos y no sobrescribe conflictos. Repetir los mismos datos es idempotente. Verifica reporte e historial; no retires originales sin comprobar. Valida estructura/JSON y existencia del MP4, no decodifica todos los videos ni importa logs antiguos.

## Diagnosticos y pruebas

La sonda anterior todavia escribe en recording_dir/_diagnostics. No ejecutarla si se requiere HDD sin JSON; diagnostics_dir esta reservado, no conectado a esa sonda. No se mueven diagnosticos existentes.

npm test incluye rutas, lectura antigua/nueva, separacion, simulacion/copia, idempotencia, conflictos y rechazo de IDs inseguros. Valida en Windows un tramo completo: MP4 en continuo, JSON en el proyecto, logs por UID y reproduccion nueva/antigua. /api/nvr/status.storagePaths muestra los destinos. No ejecutar dos escritores sobre los mismos archivos. data/logs y muestras privadas se ignoran en Git; lo ya confirmado sigue en el historial.
