# Experimental Qwen ASR service

This is a minimal prototype for running `Qwen3-ASR-0.6B` as an independent local HTTP service and wiring Foxwarm WebUI to it.

## What it does

- runs an external service at `POST /transcribe`
- accepts multipart `audio` plus optional `context`, `language`, `segmentSeconds`
- shells out to the local `qwen_asr` CPU binary
- supports WAV directly
- supports other audio formats only if `ffmpeg` is installed on the service host

## Service start

From the foxwarm repo root:

```bash
node experimental/asr/qwen-asr-service.js
```

Optional environment variables:

```bash
QWEN_ASR_SERVICE_HOST=127.0.0.1
QWEN_ASR_SERVICE_PORT=8091
QWEN_ASR_BIN=/home/ldmbot/experiments/qwen-asr/qwen_asr
QWEN_ASR_MODEL_DIR=/home/ldmbot/experiments/qwen-asr/qwen3-asr-0.6b
QWEN_ASR_THREADS=4
QWEN_ASR_SEGMENT_SECONDS=20
FFMPEG_BIN=ffmpeg
```

Health check:

```bash
curl http://127.0.0.1:8091/health
```

Transcribe test:

```bash
curl -X POST http://127.0.0.1:8091/transcribe \
  -F audio=@/home/ldmbot/experiments/qwen-asr/samples/jfk.wav \
  -F 'context=Preserve spelling: Foxwarm, Qwen, OpenBLAS'
```

## Foxwarm integration

Foxwarm backend can proxy to this service when one of these environment variables is set:

- `FOXWARM_ASR_SERVICE_URL`
- `ASR_SERVICE_URL`

Example:

```bash
export FOXWARM_ASR_SERVICE_URL=http://127.0.0.1:8091
```

When configured, WebUI exposes:

- `GET /api/asr/status`
- `POST /api/asr/transcribe`

And the chat composer shows a small `ASR` button that uploads an audio file to the proxy and inserts the transcript back into the draft.

## Current limits

- this is intentionally experimental
- no streaming yet
- no timestamps yet
- browser recording is not implemented yet
- best current path is upload-an-audio-file -> get transcript -> paste into chat