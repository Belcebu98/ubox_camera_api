# Servicio integrado — changes_funcionality4

`npm start` inicia API, visor, grabacion automatica y telemetria en un unico proceso y puerto. No es necesario arrancar server.js en paralelo. `npm run start:legacy` conserva el servidor anterior; no ejecutar ambos sobre el mismo puerto. `node recorder-server.js` y start-recorder.cmd siguen siendo equivalentes al nuevo arranque.

Conserva tu .env real; consulta .env.example para copiar ajustes sin sobrescribir credenciales. Destino predeterminado en Windows: E:/camaras. Si la cuenta tiene varias camaras, recording_camera_uid debe seleccionar exactamente una. El panel de bateria muestra todos los UIDs recibidos; la grabacion simultanea no esta implementada.

El visor se sirve en /. La API original comparte global.liveStreams y la sesion de login con el grabador. POST /api/stream/* y /api/nvr/* se bloquean para que una llamada manual no pare la grabacion automatica. Los endpoints GET de estado, eventos y video siguen disponibles. Las operaciones de nube pasan a los handlers existentes.

Se archiva H.264 primario sin recodificar y se finaliza MP4 con stream-copy. HEVC y audio no se graban. recording_fps fija la temporizacion: comprobar velocidad con reloj real. Indice 0 no garantiza HD; verificar la fuente. Los tramos se cierran al primer IDR despues de recording_segment_seconds. Archivos parciales pueden permanecer tras errores/cortes de luz y no se recuperan automaticamente. No hay garantia de captura sin huecos. Los MP4 terminados aparecen en el visor; hay zoom digital y desplazamiento sin mover la camara.

Telemetria: GET /api/nvr/cameras usa cache. Consulta a UBox por defecto cada 300 segundos; el navegador solo refresca la cache. Ausencia de dato no significa 0 %. is_battery_charging solo se muestra cuando es interpretable. fetchedAt es hora de consulta, NO de medicion; latestActivityAt no es fecha de bateria. La API puede devolver datos antiguos incluso en respuestas nuevas. El umbral bajo solo avisa, no apaga el stream. Validar consumo y aportacion solar antes de usar captura 24/7.

No se borra el historial. Se pausa grabacion bajo la reserva libre. Servicio sin autenticacion propia: por defecto loopback, no exponer directamente a Internet. Registros pueden contener UIDs e IPs aunque se oculten tokens y prefijos.

Prueba local: detener el servidor anterior, actualizar la rama, revisar .env, ejecutar npm test y npm start, abrir http://localhost:8020, comprobar estado y bateria contra la app. Grabar al menos un tramo completo, reproducirlo y comprobar duracion, zoom y cierre con Ctrl+C. Las pruebas sinteticas/de handlers no sustituyen pruebas con camara, HDD Windows y ejecucion prolongada.
