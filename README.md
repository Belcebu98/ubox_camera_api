# UBox Camera API · Grabador local

API no oficial, visor web y grabador local para cámaras compatibles con el protocolo implementado en este repositorio. El servicio inicia sesión en UBox, obtiene la cámara seleccionada y recibe vídeo mediante P4P/KCP.

Estado: **experimental**. Hay reproducción de vídeo validada por el usuario en su entorno, pero no una matriz completa de modelos, sistemas operativos ni pruebas de funcionamiento desatendido. No es una API oficial ni un producto afiliado o autorizado por UBIA TECHNOLOGIES CO.

> Este README describe la rama `changes_funcionality1`. No presupone que `main` o `dev` contengan estos cambios. Las muestras y documentación de protocolos no garantizan que todos los endpoints estén implementados.

## Contenido

- [Estado de las funciones](#estado-de-las-funciones)
- [Arquitectura](#arquitectura)
- [Instalación y primer arranque](#instalación-y-primer-arranque)
- [Configuración](#configuración)
- [Grabaciones](#grabaciones)
- [Visor y batería](#visor-y-batería)
- [API disponible](#api-disponible)
- [Diagnóstico y pruebas](#diagnóstico-y-pruebas)
- [Problemas frecuentes](#problemas-frecuentes)
- [Seguridad y límites](#seguridad-y-límites)
- [Desarrollo y créditos](#desarrollo-y-créditos)

## Estado de las funciones

| Función | Estado real |
| --- | --- |
| API, web y grabador con `npm start` | Integrados en un proceso y puerto |
| Inicio de sesión y selección automática de cámara | Implementados; UID obligatorio si hay varias cámaras |
| Captura sin navegador abierto | Implementada mientras el proceso y la conexión funcionan |
| Grabación MP4 de vídeo H.264 primario | Implementada, sin recodificación del vídeo archivado |
| Directo en navegador | HLS recodificado; tiene latencia |
| Reproducción, descarga, búsqueda dentro de archivos y zoom digital | Implementados en el visor |
| Batería y estado de carga por UID | Lectura de `device_list`, con caché y estado de actualización |
| Varias cámaras en el panel de batería | Admitidas según los datos devueltos por UBox |
| Varias cámaras grabando simultáneamente | No implementado: una sesión activa por instancia |
| Audio en directo o en MP4 | No implementado; diagnóstico de códec en curso |
| Avisos del sensor vinculados a grabaciones | No implementados; falta identificar y validar los eventos |
| RTSP, WebRTC y conexión lista para Frigate | Pendientes; no hay una salida RTSP activa en el arranque actual |
| Grabación HEVC/H.265 | No implementada en el archivador original |
| Audio bidireccional, PTZ y control físico | No implementados en la web |
| Borrado por antigüedad o tamaño | No implementado; no se purga el historial automáticamente |
| Recuperación automática de archivos parciales | No implementada |

## Arquitectura

```text
Cuenta UBox → login y lista de dispositivos → cámara configurada
                                              │
                                        recepción P4P/KCP
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      │                                               │
              H.264 recibido                                  preparación HLS
              empaquetado en MP4                              FFmpeg recodifica
              sin recodificar                                 para el navegador
                      │                                               │
              almacenamiento local                            visor en directo
```

El login, la API y el grabador comparten estado dentro de una instancia. Cerrar el visor no detiene la captura. No hace falta iniciar `server.js` en paralelo.

El archivo conserva el vídeo H.264 recibido, no la copia recodificada del visor. Esto no demuestra que el stream seleccionado sea la máxima calidad de la cámara. El índice de stream debe verificarse con cada modelo.

El proyecto depende de los servicios UBox para autenticación/descubrimiento y de la conectividad disponible; no se garantiza funcionamiento aislado de Internet ni transporte exclusivamente LAN.

## Instalación y primer arranque

### Requisitos

- Git y Node.js con npm.
- Cuenta UBox con permisos sobre la cámara.
- Espacio de almacenamiento y permisos de escritura en la carpeta elegida.
- Dependencias npm instaladas, incluidos los binarios administrados por `ffmpeg-static` y `ffprobe-static`.

No hay todavía una versión mínima de Node declarada mediante `engines` ni una matriz de versiones validada. Se utilizan APIs como `node:test` y `fs.statfs`: no usar una versión antigua sin comprobar compatibilidad. Para reproducir un entorno funcional, conserva sus versiones y `package-lock.json`.

Si npm necesita compilar una dependencia nativa en Windows, puede requerir Python y Visual Studio Build Tools con desarrollo de escritorio C++. No instalar herramientas adicionales salvo que el error de instalación las requiera.

### Instalación nueva en Windows / PowerShell

```powershell
git clone --branch changes_funcionality1 https://github.com/Belcebu98/ubox_camera_api.git
cd ubox_camera_api
npm ci
```

Crea `.env` solo si no existe:

```powershell
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
}
notepad .env
```

Introduce tus credenciales y revisa la ruta de almacenamiento. No dejes `your_email` o `your_password` como valores reales.

```dotenv
email=TU_EMAIL
password=TU_PASSWORD
server_host=127.0.0.1
server_port=8020
recording_dir=E:/camaras
recording_camera_uid=UID_REAL_DE_LA_CAMARA
```

Si la cuenta tiene exactamente una cámara, `recording_camera_uid` puede quedar vacío. Si tiene varias, configura un único UID; una lista separada por comas no está soportada.

Ejecuta:

```powershell
npm test
npm start
```

Abre `http://localhost:8020`. El servidor intenta conectar y grabar automáticamente. El navegador no tiene botones de inicio/parada de la sesión de captura.

Este comando no instala un servicio de Windows ni configura arranque al encender el PC. El proceso, la red y el disco deben seguir disponibles; la suspensión del equipo interrumpe el servicio.

### Linux / WSL

El código incluye componentes multiplataforma, pero no se certifica aquí su funcionamiento completo en Linux/WSL. Usa una ruta absoluta válida y accesible desde ese entorno, no una ruta de Windows interpretada como Linux. Instala las dependencias en el entorno donde ejecutarás Node y valida los binarios de FFmpeg.

### Comandos

| Comando | Uso |
| --- | --- |
| `npm start` | API, visor, grabador automático y batería |
| `npm run start:recorder` | Alias del mismo servicio integrado |
| `node recorder-server.js` | Ejecución directa del servicio integrado |
| `.\start-recorder.cmd` | Lanzador de Windows desde la raíz |
| `npm run start:legacy` | Servidor anterior, sin el arranque automático del grabador integrado |
| `npm test` | Pruebas disponibles en `tests/` |

No ejecutes integrado y legacy sobre el mismo puerto. El visor actual está diseñado para el servicio integrado; el modo legacy no ofrece todas las rutas `/api/nvr/` que utiliza. `npm run main` no existe en los scripts actuales.

Para cerrar normalmente, pulsa `Ctrl + C` y espera a que finalicen los archivos. Un cierre forzado puede dejar tramos parciales.

## Configuración

Consulta [.env.example](.env.example): incluye comentarios, rangos y opciones exclusivas del modo legacy. El `.env` real es privado y no debe subirse al repositorio.

| Variable | Plantilla / valor habitual | Significado |
| --- | --- | --- |
| `email`, `password` | Configurar localmente | Credenciales de la cuenta; usar contraseña original, no el hash generado por otra herramienta |
| `server_port` | `8020` | Puerto HTTP compartido por API y visor |
| `server_host` | `127.0.0.1` | Escucha local; `0.0.0.0` amplía el acceso a las interfaces de red |
| `recording_dir` | `E:/camaras` | Carpeta raíz de las grabaciones |
| `recording_camera_uid` | Vacío o UID | Cámara que graba esta instancia; necesario si hay varias |
| `recording_stream_index` | `0` | Índice solicitado, entre 0 y 3; no es una equivalencia HD verificada |
| `recording_fps` | `15` | FPS para temporizar el MP4; comprobar velocidad real |
| `recording_segment_seconds` | `300` | Duración objetivo por tramo, de 10 a 3600 segundos |
| `recording_min_free_gb` | `2` | Reserva libre en GiB; la grabación se pausa por debajo del umbral |
| `hls_fps` | `15` | Temporización de la salida HLS recodificada |
| `battery_poll_seconds` | `300` | Intervalo de telemetría UBox; de 60 a 86400 segundos |
| `battery_low_percent` | `20` | Umbral de aviso visual; no pausa la grabación |
| `debug_mode` | `false` | Diagnóstico general de helpers/UBox |
| `stream_log_console` | `false` | Imprime eventos del stream en consola; puede generar mucho volumen |

El integrado guarda eventos de sesión en `stream-logs` y no necesita activar `stream_dump_video` para crear MP4. `stream_log_file` y `stream_dump_video` se usan en `server.js` legacy. `rtsp_port` no habilita RTSP: el módulo heredado no se carga en el arranque actual. Las antiguas variables `hls_canvas_width` y `hls_canvas_height` ya no controlan el puente HLS actual.

### Cámaras solares

El panel puede avisar de batería baja, pero no administra un presupuesto energético. No garantiza que el panel solar compense el consumo de la transmisión continua. Valida la evolución de la batería, especialmente durante la noche, antes de dejar captura permanente.

## Grabaciones

Estructura de ejemplo:

```text
E:/camaras/
└── UID_CAMARA/
    └── 2026-11-04/
        ├── 2026-11-04_10-00-00_123-a1b2c3.mp4
        └── 2026-11-04_10-00-00_123-a1b2c3.mp4.json
```

- La fecha/hora del nombre corresponde al inicio del tramo según el reloj local del servidor.
- Milisegundos y sufijo reducen colisiones; no son un identificador del evento de la cámara.
- La metadata JSON contiene horas UTC, fotogramas, FPS configurados y zona horaria.
- Los cortes esperan a un fotograma clave: `300` segundos no implica un corte exacto en el segundo 300.
- `.partial.mp4` es un tramo en escritura; `.processing.mp4` corresponde a la finalización. No borrarlos mientras el proceso los utiliza.
- Solo los MP4 terminados aparecen en el historial web.
- La lista web muestra hasta 500 archivos. Los anteriores permanecen en disco.
- No hay purga automática. La reserva libre se comprueba periódicamente y no elimina archivos para recuperar espacio.
- Los fallos de conexión, disco o alimentación pueden dejar huecos o parciales. No hay garantía de grabación sin pérdida ni recuperación automática tras apagado brusco.

El multiplexor usa FPS configurados. No se garantiza todavía correspondencia exacta entre hora de cámara, recepción y posición del archivo. Comprueba duración y velocidad contra un reloj visible antes de usar timestamps como evidencia precisa.

## Visor y batería

En el servicio integrado, `/` y `/index.html` sirven `public/recorder.html`; `public/index.html` mantiene el mismo contenido y una prueba comprueba esa igualdad. El servidor añade `battery-panel.js` al HTML servido. No abras el HTML directamente desde el disco: necesita la API.

Controles del visor:

- Ver directo / volver al directo, pausar y cerrar visor.
- Pantalla completa, según soporte del navegador.
- Zoom digital de 1× a 8×; rueda sobre una zona y arrastre para desplazar.
- Abrir, descargar y avanzar por grabaciones terminadas.

No hay controles físicos de movimiento ni ventana de eventos. El zoom no crea detalle adicional ni altera el archivo. El navegador usa `hls.js` desde un CDN cuando necesita ese reproductor; un bloqueo del CDN puede impedir el directo.

El directo HLS tiene retraso por recepción, codificación, segmentos y búfer. No se promete latencia cero ni se presenta esta ruta como WebRTC. El visor intenta recuperarse de determinados errores HLS con reintentos limitados; esto no garantiza recuperación de cualquier fallo de cámara.

### Interpretación de batería

Se asocian `items` e `infos` por UID. Los campos de origen son `dynamic_info.battery` e `is_battery_charging` cuando están disponibles.

- Un campo ausente o inválido se muestra como «sin dato», no como 0 %.
- La hora de consulta no es una hora de medición confirmada.
- La última actividad del dispositivo no es un timestamp de batería.
- Una respuesta nueva de la nube puede contener valores antiguos.
- Si falla una actualización se conserva la caché con aviso; también se informa cuando queda desactualizada.
- El navegador lee la caché local. No solicita una consulta UBox por cada actualización de pantalla.
- «Cargando» refleja el campo devuelto por la API, no una medición independiente de la aportación solar.

## API disponible

Todas estas rutas usan el puerto HTTP configurado. No existe una capa de autenticación propia del servidor; algunas llamadas usan internamente la sesión UBox.

### Grabador y visor

| Método | Ruta | Función |
| --- | --- | --- |
| GET | `/api/nvr/status` | Estado de recepción, grabación, espacio y último error |
| GET | `/api/nvr/cameras` | Telemetría en caché por UID y cámara activa |
| GET | `/api/nvr/recordings` | Hasta 500 grabaciones terminadas |
| GET / HEAD | `/api/nvr/video?id=...` | MP4 terminado; admite rangos de bytes para reproducción |
| GET | `/api/stream/live.m3u8?track=primary` | Lista de reproducción HLS |
| GET | `/api/stream/hls/primary/seg_N.ts` | Segmentos HLS administrados por el puente |
| GET | `/api/stream/status` | Estado detallado del gestor y eventos recientes |
| GET | `/api/stream/events` | SSE con eventos `snapshot` y `log` |
| GET | `/api/stream/live.h264?track=primary` | Salida interna con prefijos de longitud; no es Annex-B crudo directamente consumible |

La pista secundaria solo contiene vídeo si el dispositivo y el enrutamiento implementado la producen. No equivale automáticamente a un substream de baja resolución.

En modo integrado se rechazan las operaciones POST bajo `/api/stream/` y `/api/nvr/` para que no cambien manualmente la sesión del grabador. Las rutas de inicio/parada del handler legacy no controlan la captura del integrado.

### Operaciones UBox implementadas en el handler actual

| Método | Ruta |
| --- | --- |
| GET | `/api/v2/user/device_list` |
| GET | `/api/user/families` |
| GET | `/api/user/get_subscription_ios_device` |
| GET | `/api/login/expires_in` |
| POST | `/api/user/qry/device/device_services` |
| POST | `/api/user/cloud_list` |

Los cuerpos y respuestas pueden depender del proveedor; consulta [api_docs](api_docs/) y [docs](docs/). La existencia de un JSON de ejemplo, un archivo de documentación o una función antigua no demuestra que haya una ruta habilitada. No se anuncian calendario, información SIM o URL de vídeo de nube como endpoints disponibles sin verificar sus handlers.

Ejemplos PowerShell:

```powershell
Invoke-RestMethod http://localhost:8020/api/nvr/status |
    ConvertTo-Json -Depth 10

Invoke-RestMethod http://localhost:8020/api/nvr/cameras |
    ConvertTo-Json -Depth 10
```

## Diagnóstico y pruebas

```powershell
npm test
```

Hay pruebas de preparación de fotogramas HLS, normalización/caché de batería, contrato del frontend y límites de la sonda. Estas pruebas no certifican conectividad UBox, calidad de imagen, reproducción real, precisión temporal, autonomía solar o funcionamiento del HDD de Windows.

Los registros de sesión están en `stream-logs/`. `lastError` es el último error conservado y puede referirse a un fallo anterior; contrastarlo con el estado actual. Para una prueba útil, conserva el intervalo desde conexión hasta reproducción y parada, anotando las horas de las acciones.

### Sonda opcional de audio/eventos

[Guía de captura](docs/audio-event-diagnostics.md). Con el servidor anterior detenido:

```powershell
$env:UBOX_STREAM_PROBE="1"
node --require ./tools/capture-stream-probe.js recorder-server.js
```

Observa registros KCP durante un máximo de 60 segundos o 2 MiB; guarda metadata y payloads candidatos `0x13` en `_diagnostics` bajo `recording_dir`. No decodifica audio ni clasifica eventos de movimiento. Otros canales pueden quedar fuera de la captura.

Después de la prueba, pulsa `Ctrl + C` y vuelve al arranque normal:

```powershell
Remove-Item Env:UBOX_STREAM_PROBE -ErrorAction SilentlyContinue
npm start
```

Las muestras pueden contener sonido privado. No subirlas a GitHub. Una hipótesis de decodificación offline no implica que exista audio integrado en el directo o el MP4.

## Problemas frecuentes

| Síntoma | Comprobación |
| --- | --- |
| `npm` bloqueado por PowerShell | Probar `npm.cmd`; revisar la política de scripts sin desactivar protecciones globalmente |
| Instalación falla con `node-gyp` | Leer el error concreto: Python, herramientas C++ o compatibilidad del módulo |
| Puerto ocupado | Detener la otra instancia; no arrancar legacy e integrado en el mismo puerto |
| Error de selección de cámara | Configurar un solo `recording_camera_uid` válido |
| Estado conectado sin vídeo | Consultar último fotograma y logs; una sesión creada no demuestra recepción |
| No aparece el tramo actual en la web | Esperar al corte y finalización; comprobar errores y espacio |
| MP4 demasiado rápido o lento | Verificar FPS configurados y pérdida/variación de fotogramas |
| La web muestra rutas NVR no disponibles | Comprobar rama/commit y usar `npm start`, no el servidor legacy |
| Batería ausente o antigua | Revisar `/api/nvr/cameras` y contrastar con la aplicación móvil |
| FFmpeg falla | Conservar stderr y estado de sesión; no reinstalar Node indiscriminadamente |
| Git indica divergencia o conflicto | Revisar `git status` y preservar cambios; no usar `reset --hard` ni force-push como solución automática |

Para actualizar una copia limpia y sin divergencia:

```powershell
git fetch origin
git switch changes_funcionality1
git pull --ff-only origin changes_funcionality1
npm test
npm start
```

Si existe una fusión pendiente o commits locales exclusivos, resolverlos conscientemente antes de continuar. No sobrescribir `.env` al actualizar. Para refrescar la web, usar `Ctrl + F5`.

## Seguridad y límites

- Escucha por defecto en loopback. No exponer directamente el servicio sin autenticación, HTTPS y controles de acceso adecuados.
- No publicar `.env`, `.storedLogin.json`, contraseñas, tokens, vídeo, audio ni capturas privadas.
- `.gitignore` no revisa secretos dentro de los archivos ni elimina datos ya confirmados en el historial. Revisar también los binarios y muestras añadidos manualmente.
- Restringir permisos del HDD y mantener la hora del sistema correctamente configurada.
- No se garantizan cifrado de archivos locales, tolerancia a fallos, retención automática, copias de seguridad o recuperación tras cortes de luz.
- Cambios del servicio UBox o del firmware pueden alterar compatibilidad y disponibilidad.
- Usar solo cámaras y cuentas autorizadas y gestionar las grabaciones conforme a las obligaciones aplicables.

### Frigate y siguientes pasos

La salida RTSP estable por UID, la visualización WebRTC/MSE, el audio sincronizado, las advertencias del sensor y las sesiones multicámara son trabajo pendiente. No hay todavía un `config.yml` de Frigate que convierta por sí solo el endpoint interno `live.h264` en una fuente RTSP lista para usar.

## Desarrollo y créditos

```text
recorder-server.js       Servicio integrado y grabador automático
server.js                Servidor legacy
public/                  Visores y panel de batería
src/main/                Handlers, helpers, HLS y RTSP heredado
src/stream/              P4P/KCP, detección de formato y multiplexores MP4
tools/                   Sonda opcional de diagnóstico
tests/                   Pruebas automáticas
docs/                    Documentación funcional y diagnóstica
api_docs/                Ejemplos de contratos UBox
.env.example             Plantilla pública comentada
```

Contribuciones: describir modelo/firmware, rama/commit, versión de Node, sistema operativo, pasos de reproducción y registros sanitizados. No adjuntar credenciales ni capturas privadas a issues públicos. Consultar [CONTRIBUTING.md](CONTRIBUTING.md) y las plantillas del repositorio; algunas instrucciones históricas pueden necesitar adaptación a esta rama.

Créditos conservados del proyecto original:

- [JEMcats](https://github.com/JEMcats): proyecto original UBox Camera API.
- [asyrk](https://github.com/asyrk) / [ubox-web](https://github.com/asyrk/ubox-web): código de streaming acreditado por el README original.
- [Belcebu98](https://github.com/Belcebu98/ubox_camera_api): repositorio de esta adaptación y entorno de validación local.

### Licencia

El archivo [LICENSE](LICENSE) contiene MIT y atribución a JEMcats.Software. `package.json` declara actualmente ISC: existe una discrepancia pendiente de reconciliar por los responsables del proyecto. Este README la documenta sin modificar licencias, atribuciones ni metadatos del paquete.
