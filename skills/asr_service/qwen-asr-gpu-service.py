#!/usr/bin/env python3
"""
Standalone GPU-oriented Qwen ASR service.

Intended deployment target:
- Linux with NVIDIA GPU
- or Windows + NVIDIA via WSL2 Ubuntu

Provides the same outer contract used by Foxwarm:
- GET  /health
- POST /transcribe
- WS   /ws/stream

Streaming support requires the vLLM backend.
"""

from __future__ import annotations

import asyncio
import io
import os
import tempfile
import time
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from qwen_asr import Qwen3ASRModel
import uvicorn

try:
    import librosa
except Exception:  # pragma: no cover
    librosa = None


HOST = os.getenv('QWEN_ASR_SERVICE_HOST', os.getenv('HOST', '0.0.0.0'))
PORT = int(os.getenv('QWEN_ASR_SERVICE_PORT', os.getenv('PORT', '8091')))
SERVICE_KEY = os.getenv('QWEN_ASR_SERVICE_KEY', os.getenv('ASR_SERVICE_KEY', '')).strip()
BACKEND = os.getenv('QWEN_ASR_BACKEND', 'vllm').strip().lower() or 'vllm'
MODEL_NAME = os.getenv('QWEN_ASR_MODEL', 'Qwen/Qwen3-ASR-0.6B').strip()
DTYPE_NAME = os.getenv('QWEN_ASR_DTYPE', 'bfloat16').strip().lower()
GPU_MEMORY_UTILIZATION = float(os.getenv('QWEN_ASR_GPU_MEMORY_UTILIZATION', '0.8'))
MAX_MODEL_LEN = int(os.getenv('QWEN_ASR_MAX_MODEL_LEN', '0'))
MAX_INFERENCE_BATCH_SIZE = int(os.getenv('QWEN_ASR_MAX_INFERENCE_BATCH_SIZE', '32'))
MAX_NEW_TOKENS = int(os.getenv('QWEN_ASR_MAX_NEW_TOKENS', '512'))
STREAM_UNFIXED_CHUNK_NUM = int(os.getenv('QWEN_ASR_STREAM_UNFIXED_CHUNK_NUM', '2'))
STREAM_UNFIXED_TOKEN_NUM = int(os.getenv('QWEN_ASR_STREAM_UNFIXED_TOKEN_NUM', '5'))
STREAM_CHUNK_SIZE_SEC = float(os.getenv('QWEN_ASR_STREAM_CHUNK_SIZE_SEC', '2.0'))


def get_dtype():
    if DTYPE_NAME == 'float16':
        return torch.float16
    if DTYPE_NAME == 'float32':
        return torch.float32
    return torch.bfloat16


def is_authorized_header(value: Optional[str]) -> bool:
    if not SERVICE_KEY:
        return True
    return value == f'Bearer {SERVICE_KEY}'


def get_auth_header(request: Request) -> Optional[str]:
    return request.headers.get('authorization')


async def ensure_http_auth(request: Request) -> None:
    if not is_authorized_header(get_auth_header(request)):
        raise HTTPException(status_code=401, detail='Unauthorized')


class ModelHolder:
    def __init__(self) -> None:
        self.model = None
        self.lock = asyncio.Lock()

    async def get(self):
        if self.model is not None:
            return self.model
        async with self.lock:
            if self.model is not None:
                return self.model
            self.model = await asyncio.to_thread(self._load_model)
            return self.model

    def _load_model(self):
        if BACKEND == 'vllm':
            kwargs = dict(
                model=MODEL_NAME,
                gpu_memory_utilization=GPU_MEMORY_UTILIZATION,
                max_inference_batch_size=MAX_INFERENCE_BATCH_SIZE,
                max_new_tokens=MAX_NEW_TOKENS,
            )
            if MAX_MODEL_LEN > 0:
                kwargs['max_model_len'] = MAX_MODEL_LEN
            return Qwen3ASRModel.LLM(**kwargs)

        return Qwen3ASRModel.from_pretrained(
            MODEL_NAME,
            dtype=get_dtype(),
            device_map='cuda:0',
            max_inference_batch_size=MAX_INFERENCE_BATCH_SIZE,
            max_new_tokens=MAX_NEW_TOKENS,
        )


holder = ModelHolder()
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)


def normalize_language(value: Optional[str]) -> Optional[str]:
    text = (value or '').strip()
    return text or None


def load_audio_from_bytes(raw: bytes, suffix: str) -> tuple[np.ndarray, int]:
    try:
        wav, sr = sf.read(io.BytesIO(raw), dtype='float32', always_2d=False)
        wav = np.asarray(wav, dtype=np.float32)
        if wav.ndim > 1:
            wav = wav.mean(axis=1)
        return wav, int(sr)
    except Exception:
        if librosa is None:
            raise RuntimeError('soundfile failed to decode audio and librosa is not available')

    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or '.audio') as tmp:
        tmp.write(raw)
        temp_path = tmp.name

    try:
        wav, sr = librosa.load(temp_path, sr=None, mono=True)
        return np.asarray(wav, dtype=np.float32), int(sr)
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass


def pcm16_bytes_to_float32(raw: bytes) -> np.ndarray:
    pcm = np.frombuffer(raw, dtype=np.int16)
    if pcm.size == 0:
        return np.zeros((0,), dtype=np.float32)
    return (pcm.astype(np.float32) / 32768.0).astype(np.float32)


@app.get('/health')
async def health(request: Request):
    await ensure_http_auth(request)
    return {
        'ok': True,
        'protected': bool(SERVICE_KEY),
        'backend': BACKEND,
        'model': MODEL_NAME,
        'dtype': DTYPE_NAME,
        'maxModelLen': MAX_MODEL_LEN or None,
        'cudaAvailable': torch.cuda.is_available(),
        'cudaDeviceCount': torch.cuda.device_count(),
        'streamingSupported': BACKEND == 'vllm',
        'streamingConfig': {
            'unfixedChunkNum': STREAM_UNFIXED_CHUNK_NUM,
            'unfixedTokenNum': STREAM_UNFIXED_TOKEN_NUM,
            'chunkSizeSec': STREAM_CHUNK_SIZE_SEC,
        },
    }


@app.post('/transcribe')
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    context: str = Form(''),
    language: str = Form(''),
):
    await ensure_http_auth(request)

    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail='Missing audio data')

    model = await holder.get()
    suffix = Path(audio.filename or 'audio.wav').suffix
    wav, sr = await asyncio.to_thread(load_audio_from_bytes, raw, suffix)
    started_at = time.time()
    results = await asyncio.to_thread(
        model.transcribe,
        (wav, sr),
        context=(context or '').strip() or None,
        language=normalize_language(language),
        return_time_stamps=False,
    )
    elapsed_ms = int((time.time() - started_at) * 1000)
    result = results[0]
    return {
        'text': result.text or '',
        'language': getattr(result, 'language', None),
        'elapsedMs': elapsed_ms,
        'backend': BACKEND,
        'model': MODEL_NAME,
        'originalName': audio.filename,
        'usedPrompt': bool((context or '').strip()),
        'usedLanguage': normalize_language(language),
    }


@app.websocket('/ws/stream')
async def websocket_stream(ws: WebSocket):
    auth = ws.headers.get('authorization')
    if not is_authorized_header(auth):
      await ws.close(code=1008, reason='Unauthorized')
      return

    if BACKEND != 'vllm':
        await ws.accept()
        await ws.send_json({'type': 'error', 'error': 'Streaming requires QWEN_ASR_BACKEND=vllm'})
        await ws.close(code=1011)
        return

    await ws.accept()
    model = await holder.get()
    state = None

    try:
        while True:
            message = await ws.receive()
            if 'bytes' in message and message['bytes'] is not None:
                if state is None:
                    await ws.send_json({'type': 'error', 'error': 'Streaming session not started yet'})
                    continue
                seg = pcm16_bytes_to_float32(message['bytes'])
                await asyncio.to_thread(model.streaming_transcribe, seg, state)
                await ws.send_json({
                    'type': 'partial',
                    'text': getattr(state, 'text', '') or '',
                    'language': getattr(state, 'language', None),
                })
                continue

            data = message.get('text')
            if data is None:
                continue

            import json
            payload = json.loads(data)
            msg_type = payload.get('type')

            if msg_type == 'start':
                state = model.init_streaming_state(
                    unfixed_chunk_num=STREAM_UNFIXED_CHUNK_NUM,
                    unfixed_token_num=STREAM_UNFIXED_TOKEN_NUM,
                    chunk_size_sec=STREAM_CHUNK_SIZE_SEC,
                )
                await ws.send_json({'type': 'ready'})
                continue

            if msg_type == 'stop':
                if state is None:
                    await ws.send_json({'type': 'error', 'error': 'Streaming session not started yet'})
                    continue
                await asyncio.to_thread(model.finish_streaming_transcribe, state)
                await ws.send_json({
                    'type': 'final',
                    'text': getattr(state, 'text', '') or '',
                    'language': getattr(state, 'language', None),
                })
                state = None
                continue

            if msg_type == 'ping':
                await ws.send_json({'type': 'pong'})
                continue

            await ws.send_json({'type': 'error', 'error': f'Unknown websocket message type: {msg_type or "unknown"}'})
    except WebSocketDisconnect:
        return
    except Exception as exc:
        try:
            await ws.send_json({'type': 'error', 'error': str(exc)})
        except Exception:
            pass
        try:
            await ws.close(code=1011)
        except Exception:
            pass


def main() -> None:
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == '__main__':
    main()