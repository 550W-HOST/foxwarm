---
name: asr_service
description: Standalone Qwen ASR service bundle and integration guide for Foxwarm backend proxy mode.
---

# asr_service

Use this skill when you need to deploy, repair, or integrate the standalone ASR service used by Foxwarm.

## What this skill contains

- service entrypoint: `skills/asr_service/qwen-asr-service.js`
- setup guidance for CPU-first local deployment
- integration guidance for Foxwarm `state/config.yaml`

## Recommended architecture

```text
Browser -> Foxwarm /api/asr/* -> standalone ASR service
```

Why:

- browser should not know the ASR key
- Foxwarm can keep same-origin WebUI requests
- ASR backend can be swapped later without changing WebUI UX

## Foxwarm config

Add this to `state/config.yaml`:

```yaml
asrService:
  enabled: true
  url: http://127.0.0.1:8091
  key: change-me
```

Foxwarm backend then exposes:

- `GET /api/asr/status`
- `POST /api/asr/transcribe`
- `WS /api/asr/stream`

## Minimal CPU-based setup

Current practical prototype uses:

- `antirez/qwen-asr`
- `Qwen/Qwen3-ASR-0.6B`
- OpenBLAS

Typical host setup:

```bash
sudo apt-get install -y libopenblas-dev
git clone https://github.com/antirez/qwen-asr
cd qwen-asr
make blas
./download_model.sh --model small --dir qwen3-asr-0.6b
```

## Start the service

From the foxwarm repo root:

```bash
export QWEN_ASR_SERVICE_HOST=0.0.0.0
export QWEN_ASR_SERVICE_PORT=8091
export QWEN_ASR_SERVICE_KEY='change-me'
export QWEN_ASR_BIN=/path/to/qwen_asr
export QWEN_ASR_MODEL_DIR=/path/to/qwen3-asr-0.6b

node skills/asr_service/qwen-asr-service.js
```

Optional env:

```bash
export QWEN_ASR_THREADS=4
export QWEN_ASR_SEGMENT_SECONDS=20
export FFMPEG_BIN=ffmpeg
```

## Verify it

```bash
curl -H 'Authorization: Bearer change-me' http://127.0.0.1:8091/health

curl -X POST http://127.0.0.1:8091/transcribe \
  -H 'Authorization: Bearer change-me' \
  -F audio=@/path/to/test.wav
```

## Notes

- Without `ffmpeg`, prefer WAV input.
- Current prototype backend is CPU-oriented.
- Later GPU implementations can keep the same service contract while swapping inference backend.
- If you need Foxwarm-side troubleshooting, first check `/api/asr/status` from Foxwarm itself.