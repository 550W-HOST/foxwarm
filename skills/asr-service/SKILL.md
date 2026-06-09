---
name: asr-service
description: Standalone Qwen ASR service bundle and integration guide for Foxwarm backend proxy mode.
---

# asr-service

Use this skill when you need to deploy, repair, or integrate the standalone ASR service used by Foxwarm.

## What this skill contains

- service entrypoint: `skills/asr-service/qwen-asr-service.js`
- GPU service entrypoint: `skills/asr-service/qwen-asr-gpu-service.py`
- GPU service deps: `skills/asr-service/requirements-gpu.txt`
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

node skills/asr-service/qwen-asr-service.js
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

## Windows + NVIDIA GPU deployment

For a practical GPU deployment on a Windows machine, the recommended path is:

```text
Windows host + NVIDIA driver + WSL2 Ubuntu + qwen-asr[vllm]
```

### Why WSL2

- official `qwen-asr` GPU path is Python/CUDA oriented
- official streaming support is tied to the vLLM backend
- vLLM does **not** support native Windows directly; WSL2 Linux is the practical route

### Files to use

- service: `skills/asr-service/qwen-asr-gpu-service.py`
- deps: `skills/asr-service/requirements-gpu.txt`

### Suggested WSL2 setup

Inside Ubuntu on WSL2:

```bash
sudo apt-get update
sudo apt-get install -y build-essential

python3 -m venv .venv
source .venv/bin/activate
pip install -U pip wheel

# install CUDA-enabled PyTorch first according to your CUDA version
# example only; adjust to your environment
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128

pip install -r skills/asr-service/requirements-gpu.txt

# optional but recommended for lower VRAM / better speed when supported
pip install -U flash-attn --no-build-isolation
```

### Start GPU service

```bash
export QWEN_ASR_SERVICE_HOST=0.0.0.0
export QWEN_ASR_SERVICE_PORT=8091
export QWEN_ASR_SERVICE_KEY='change-me'
export QWEN_ASR_BACKEND=vllm
export QWEN_ASR_MODEL='Qwen/Qwen3-ASR-0.6B'
export QWEN_ASR_DTYPE='bfloat16'
export QWEN_ASR_GPU_MEMORY_UTILIZATION='0.8'
export QWEN_ASR_MAX_MODEL_LEN='32768'

python skills/asr-service/qwen-asr-gpu-service.py
```

Additional optional env for smaller / mid-range GPUs:

```bash
# vLLM may otherwise try the model's full default max seq len (65536)
# which can exceed KV-cache budget on cards around the RTX 4070 class.
export QWEN_ASR_MAX_MODEL_LEN='32768'

# if you need a bit more KV-cache budget, increase carefully.
export QWEN_ASR_GPU_MEMORY_UTILIZATION='0.9'
```

### What this GPU service supports

- `GET /health`
- `POST /transcribe`
- `WS /ws/stream`

So Foxwarm can keep using the same `asrService.url/key` contract.

### Foxwarm config example for remote GPU host

```yaml
asrService:
  enabled: true
  url: http://YOUR_GPU_PC_IP:8091
  key: change-me
```

### Current caveats

- this GPU service has now been runtime-validated on a WSL2 + RTX 4070 setup, but the validated config needed:
  - system compiler installed (`build-essential`)
  - `QWEN_ASR_MAX_MODEL_LEN=32768`
  - `QWEN_ASR_GPU_MEMORY_UTILIZATION=0.9`
- without a compiler, vLLM / Triton startup can fail while compiling backend helpers
- with the default model max seq len `65536`, vLLM may fail KV-cache initialization on ~12 GB GPUs; lowering `QWEN_ASR_MAX_MODEL_LEN` is the intended fix
- `/health` only checks service availability; it does **not** force full model preload
- first real inference can therefore be much slower than later ones because model load / warmup / graph capture happen lazily
- streaming support depends on vLLM backend availability in WSL2
- minimal websocket control-path smoke (`start -> ready`, immediate `stop -> final`) was validated, but full audio-chunk streaming recognition should still be tested separately before relying on it in production
- if you only need stable final transcription first, start with `POST /transcribe` validation before testing `/ws/stream`
