# Panel multi-cámara

El panel `/multi-camera` muestra todas las cámaras asociadas a la cuenta UBox, incluyendo su **UID**, nombre, estado y batería cuando la API la proporciona.

## Uso

1. Abre `http://localhost:8020/multi-camera`.
2. Revisa la tarjeta de cada cámara; el UID aparece siempre visible.
3. Pulsa **Grabar esta cámara** para cambiar la cámara cuyo stream se está grabando.
4. El panel se actualiza cada 5 segundos.

## Endpoints utilizados

| Endpoint | Función |
|---|---|
| `GET /api/nvr/cameras` | Lista las cámaras y telemetría disponible |
| `GET /api/nvr/status` | Indica la cámara activa, conexión, recepción de vídeo y grabación |
| `POST /api/nvr/select-camera` | Cambia la cámara seleccionada; cuerpo: `{ "uid": "UID_DE_LA_CAMARA" }` |

## Grabación

Actualmente el grabador mantiene **una sesión de vídeo activa** y graba de forma continua la cámara seleccionada. Al cambiar de cámara, se detiene la sesión anterior, se cierra el HLS activo y el planificador inicia la nueva cámara en el siguiente ciclo.

La grabación simultánea de varias cámaras requiere convertir el grabador actual en un gestor con una sesión, muxer, HLS y almacenamiento independientes por UID. Ese cambio se hará en una fase posterior para no comprometer la grabación actual.
