# Experimental Qwen ASR service

This is a minimal prototype for running `Qwen3-ASR-0.6B` as an independent local HTTP service and wiring Foxwarm WebUI to it.

## What it does

- runs an external service at `POST /transcribe`
- accepts multipart `audio` plus optional `context`, `language`, `segmentSeconds`
- shells out to the local `qwen_asr` CPU binary
- supports WAV directly
- supports other audio formats only if `ffmpeg` is installed on the service host
- includes permissive CORS headers so Foxwarm WebUI on port 3002 can call it directly from the browser

For the current public/private integration direction, Foxwarm should normally call this service through its own backend proxy using a configured service key.

## Service start

From the foxwarm repo root:

```bash
node experimental/asr/qwen-asr-service.js
```

Optional environment variables:

```bash
QWEN_ASR_SERVICE_HOST=0.0.0.0
QWEN_ASR_SERVICE_PORT=8091
QWEN_ASR_SERVICE_KEY=change-me
QWEN_ASR_BIN=/home/ldmbot/experiments/qwen-asr/qwen_asr
QWEN_ASR_MODEL_DIR=/home/ldmbot/experiments/qwen-asr/qwen3-asr-0.6b
QWEN_ASR_THREADS=4
QWEN_ASR_SEGMENT_SECONDS=20
FFMPEG_BIN=ffmpeg
```

Health check:

```bash
curl http://127.0.0.1:8091/health

# when key protection is enabled
curl -H 'Authorization: Bearer change-me' http://127.0.0.1:8091/health
```

Transcribe test:

```bash
curl -X POST http://127.0.0.1:8091/transcribe \
  -H 'Authorization: Bearer change-me' \
  -F audio=@/home/ldmbot/experiments/qwen-asr/samples/jfk.wav \
  -F 'context=Preserve spelling: Foxwarm, Qwen, OpenBLAS'
```

## Foxwarm integration

Foxwarm should normally proxy requests to this service from the backend so the browser does not need to know the service URL or key.

Add this to `state/config.yaml` on the Foxwarm side:

```yaml
asrService:
  enabled: true
  url: http://127.0.0.1:8091
  key: change-me
```

Then Foxwarm can expose same-origin endpoints such as:

```text
GET /api/asr/status
POST /api/asr/transcribe
WS /api/asr/stream
```

The WebUI can then talk only to Foxwarm's own `/api/asr/*` routes.

## Current limits

- this is intentionally experimental
- no streaming yet
- no timestamps yet
- browser recording is not implemented yet
- best current path is upload-an-audio-file -> get transcript -> paste into chat