---
name: asr_service_setup
description: Guide for installing and configuring the standalone Qwen ASR service used by Foxwarm.
---

# asr_service_setup

Use this skill when you need to deploy or repair the standalone ASR service that Foxwarm can call.

## Recommended deployment shape

- Run ASR as a separate local or remote service.
- Protect it with a secret key.
- Let Foxwarm backend proxy requests to it.
- Do not expose the service key to browsers.

## Minimal CPU-based path

Current practical CPU-first prototype uses:

- `antirez/qwen-asr`
- `Qwen/Qwen3-ASR-0.6B`
- OpenBLAS

Typical steps:

```bash
sudo apt-get install -y libopenblas-dev
git clone https://github.com/antirez/qwen-asr
cd qwen-asr
make blas
./download_model.sh --model small --dir qwen3-asr-0.6b
```

## Start the service

```bash
export QWEN_ASR_SERVICE_HOST=0.0.0.0
export QWEN_ASR_SERVICE_PORT=8091
export QWEN_ASR_SERVICE_KEY='change-me'
export QWEN_ASR_BIN=/path/to/qwen_asr
export QWEN_ASR_MODEL_DIR=/path/to/qwen3-asr-0.6b

node experimental/asr/qwen-asr-service.js
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
- Later GPU implementations can keep the same outer service/API shape while swapping inference backend.