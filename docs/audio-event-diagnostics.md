# Diagnostico previo a audio y eventos nativos

Esta entrega NO implementa audio reproducible, avisos PIR automaticos, RTSP ni WebRTC. Conserva registros candidatos para identificar el formato real sin asignar significados inventados a 0x13. No sustituye ni detiene la grabacion normal. La observacion de datos requiere una sesion KCP que entregue inner records; otros canales de eventos pueden no aparecer aqui.

## Ejecucion controlada en PowerShell

Deten antes el servidor actual. Conserva tu .env privado y recording_dir=E:/camaras. Ejecuta desde la raiz:

```powershell
$env:UBOX_STREAM_PROBE="1"
node --require ./tools/capture-stream-probe.js recorder-server.js
```

Solo durante esta prueba, en los primeros 60 segundos tras iniciar la sesion: anota hora local, activa el sonido en la app si lo permite sin cerrar nuestro stream, habla o da una palmada y provoca una activacion del sensor. Anota tambien la hora y texto exactos del aviso movil. No afirmamos que la app y nuestro stream puedan coexistir ni que el aviso pase por KCP. Un fallo al coexistir es informacion diagnostica, no prueba de ausencia de audio.

La sonda se cierra tras 60 segundos o al alcanzar 2 MiB combinados de datos/metadata. El servidor sigue funcionando. Para terminar la prueba pulsa Ctrl+C y luego:

```powershell
Remove-Item Env:UBOX_STREAM_PROBE -ErrorAction SilentlyContinue
npm start
```

## Archivos privados

Se crea una carpeta unica bajo E:/camaras/_diagnostics:

- records.jsonl: hora UTC de observacion y metadata de registros no clasificados como video por el gestor.
- type-0x13-candidate.bin: payloads completos de tipo 0x13, con offsets/tamanos en el JSONL.

No se guardan payloads de otros tipos, tokens de cuenta ni paquetes de login. Los candidatos NO tienen codec ni frecuencia confirmados y podrian contener audio o datos privados. No subirlos a GitHub. Revisar que nadie este siendo grabado sin autorizacion. Los permisos 0600 se solicitan, pero la proteccion real en Windows depende de las ACL de la carpeta. El UID y las horas constan en el registro.

Comparar con la app y conservar el registro normal de stream del mismo intervalo. Si el binario esta vacio, no concluir que la camara no tiene audio: puede faltar una orden de activacion o utilizar otro canal/tipo. La sonda no inventa comandos de activacion ni decodifica audio. Antes de implementar la pista final hay que verificar codec, muestreo, canales y temporizacion. Los eventos necesitan un mensaje real o respuesta de API validada y asociacion temporal, no solo actividad de video.
