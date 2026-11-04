# changes_funcionality3 — optional continuous recorder

Stop npm start before launching this service: it uses the same port. The existing server.js remains unchanged as a rollback path.

Run `node recorder-server.js` or start-recorder.cmd on Windows.

Local .env settings:

```dotenv
recording_dir=E:/camaras
server_port=8020
server_host=127.0.0.1
recording_camera_uid=YOUR_CAMERA_UID
recording_stream_index=0
recording_fps=15
recording_segment_seconds=300
recording_min_free_gb=2
```

If there is exactly one camera, recording_camera_uid may be omitted. No camera quality mapping is assumed: index 0 is configurable and must be verified against the mobile app.

This version archives the primary H.264 video without re-encoding, then uses ffmpeg stream-copy to finalize MP4 files. HEVC recording and audio are NOT implemented. The existing configured fixed FPS muxer is used: verify playback speed against a clock before relying on recordings. Files start on an IDR frame; a new file is opened on the first IDR after the requested segment duration. Names use server-local date/time, milliseconds and a collision-resistant suffix. The server clock is the reference, not an independently verified camera clock.

No deletion/retention policy is enabled. Recording pauses below the configured free-space reserve. Logs and recordings can contain camera identifiers and IP addresses. Do not expose this unauthenticated service to the Internet.

Only finalized MP4 files are listed. Partial/processing files are kept on finalization failures for manual recovery, not overwritten or automatically recovered. A power failure can lose the last open portion. There is no frame-perfect or gap-free recording guarantee. Single active camera only.

Browser controls provide digital zoom, pan, live playback and completed-recording playback. They never send camera movement commands. Digital zoom does not create additional detail or modify the stored file. Closing the browser does not stop capture. Run both a full segment test and repeated restart tests before unattended use.
