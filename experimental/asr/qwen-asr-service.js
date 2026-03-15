#!/usr/bin/env node

const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.QWEN_ASR_SERVICE_PORT || process.env.PORT || 8091);
const HOST = process.env.QWEN_ASR_SERVICE_HOST || '127.0.0.1';
const QWEN_ASR_BIN = process.env.QWEN_ASR_BIN || '/home/ldmbot/experiments/qwen-asr/qwen_asr';
const QWEN_ASR_MODEL_DIR = process.env.QWEN_ASR_MODEL_DIR || '/home/ldmbot/experiments/qwen-asr/qwen3-asr-0.6b';
const QWEN_ASR_THREADS = String(process.env.QWEN_ASR_THREADS || '4');
const QWEN_ASR_SEGMENT_SECONDS = String(process.env.QWEN_ASR_SEGMENT_SECONDS || '20');
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';

const uploadDir = path.join(os.tmpdir(), 'foxwarm-asr-service');
fs.ensureDirSync(uploadDir);

const app = express();
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
      stdio: 'ignore',
    });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`.trim()));
      }
    });
  });
}

function isLikelyWav(file) {
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();
  return name.endsWith('.wav') || name.endsWith('.wave') || mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave';
}

async function prepareInputAudio(filePath, file) {
  if (isLikelyWav(file)) {
    return { inputPath: filePath, preparedWith: 'direct-wav' };
  }

  const ffmpegAvailable = await commandExists(FFMPEG_BIN);
  if (!ffmpegAvailable) {
    throw new Error('Only WAV input is supported right now because ffmpeg is not installed on this machine');
  }

  const convertedPath = path.join(uploadDir, `${crypto.randomBytes(12).toString('hex')}.wav`);
  await runProcess(FFMPEG_BIN, ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', convertedPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { inputPath: convertedPath, preparedWith: 'ffmpeg-convert' };
}

async function buildHealth() {
  const ffmpegAvailable = await commandExists(FFMPEG_BIN);
  return {
    ok: true,
    qwenAsrBin: QWEN_ASR_BIN,
    qwenAsrBinExists: await fs.pathExists(QWEN_ASR_BIN),
    modelDir: QWEN_ASR_MODEL_DIR,
    modelDirExists: await fs.pathExists(QWEN_ASR_MODEL_DIR),
    ffmpegBin: FFMPEG_BIN,
    ffmpegAvailable,
    defaultThreads: Number(QWEN_ASR_THREADS),
    defaultSegmentSeconds: Number(QWEN_ASR_SEGMENT_SECONDS),
  };
}

app.get('/health', async (_req, res) => {
  res.json(await buildHealth());
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
  const uploadedPath = req.file?.path;
  let preparedPath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file field: audio' });
    }

    if (!(await fs.pathExists(QWEN_ASR_BIN))) {
      return res.status(500).json({ error: `Qwen ASR binary not found: ${QWEN_ASR_BIN}` });
    }

    if (!(await fs.pathExists(QWEN_ASR_MODEL_DIR))) {
      return res.status(500).json({ error: `Qwen ASR model dir not found: ${QWEN_ASR_MODEL_DIR}` });
    }

    const context = String(req.body?.context || '').trim();
    const language = String(req.body?.language || '').trim();
    const segmentSecondsRaw = String(req.body?.segmentSeconds || QWEN_ASR_SEGMENT_SECONDS).trim();
    const parsedSegmentSeconds = Number(segmentSecondsRaw);
    const segmentSeconds = Number.isFinite(parsedSegmentSeconds) && parsedSegmentSeconds >= 0
      ? String(parsedSegmentSeconds)
      : QWEN_ASR_SEGMENT_SECONDS;

    const prepared = await prepareInputAudio(req.file.path, req.file);
    preparedPath = prepared.inputPath;

    const args = ['-d', QWEN_ASR_MODEL_DIR, '-i', prepared.inputPath, '--silent', '-t', QWEN_ASR_THREADS, '-S', segmentSeconds];
    if (context) {
      args.push('--prompt', context);
    }
    if (language) {
      args.push('--language', language);
    }

    const startedAt = Date.now();
    const result = await runProcess(QWEN_ASR_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const elapsedMs = Date.now() - startedAt;
    const text = result.stdout.trim();

    res.json({
      text,
      elapsedMs,
      preparedWith: prepared.preparedWith,
      segmentSeconds: Number(segmentSeconds),
      usedPrompt: Boolean(context),
      usedLanguage: language || null,
      originalName: req.file.originalname,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (uploadedPath) {
      await fs.remove(uploadedPath).catch(() => {});
    }
    if (preparedPath && preparedPath !== uploadedPath) {
      await fs.remove(preparedPath).catch(() => {});
    }
  }
});

function createStreamingArgs({ context, language }) {
  const args = ['-d', QWEN_ASR_MODEL_DIR, '--stdin', '--stream', '-t', QWEN_ASR_THREADS];
  if (context) {
    args.push('--prompt', context);
  }
  if (language) {
    args.push('--language', language);
  }
  return args;
}

function createStreamSession(ws) {
  const state = {
    child: null,
    text: '',
    startedAt: 0,
    stopped: false,
  };

  const sendJson = (payload) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const cleanupChild = () => {
    if (state.child) {
      state.child.stdout?.removeAllListeners();
      state.child.stderr?.removeAllListeners();
      state.child.removeAllListeners();
      state.child = null;
    }
  };

  const stopChild = () => {
    state.stopped = true;
    if (state.child && !state.child.stdin.destroyed) {
      state.child.stdin.end();
    }
  };

  const fail = (message) => {
    sendJson({ type: 'error', error: message });
  };

  ws.on('message', async (message, isBinary) => {
    try {
      if (isBinary) {
        if (!state.child) {
          fail('Streaming session not started yet');
          return;
        }
        if (!state.child.stdin.destroyed) {
          state.child.stdin.write(message);
        }
        return;
      }

      const payload = JSON.parse(message.toString());
      if (payload.type === 'start') {
        if (state.child) {
          fail('Streaming session already started');
          return;
        }

        if (!(await fs.pathExists(QWEN_ASR_BIN))) {
          fail(`Qwen ASR binary not found: ${QWEN_ASR_BIN}`);
          return;
        }

        if (!(await fs.pathExists(QWEN_ASR_MODEL_DIR))) {
          fail(`Qwen ASR model dir not found: ${QWEN_ASR_MODEL_DIR}`);
          return;
        }

        const context = String(payload.context || '').trim();
        const language = String(payload.language || '').trim();
        const args = createStreamingArgs({ context, language });
        const child = spawn(QWEN_ASR_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        state.child = child;
        state.startedAt = Date.now();
        state.text = '';
        state.stopped = false;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        let stderrText = '';

        child.stdout.on('data', (chunk) => {
          state.text += chunk;
          sendJson({
            type: 'partial',
            text: state.text,
          });
        });

        child.stderr.on('data', (chunk) => {
          stderrText += chunk;
        });

        child.on('error', (error) => {
          fail(error instanceof Error ? error.message : String(error));
          cleanupChild();
        });

        child.on('close', (code) => {
          const finalText = state.text.trim();
          if (code === 0) {
            sendJson({
              type: 'final',
              text: finalText,
              elapsedMs: Date.now() - state.startedAt,
            });
          } else {
            fail(`${QWEN_ASR_BIN} exited with code ${code}${stderrText ? `\n${stderrText.trim()}` : ''}`);
          }
          cleanupChild();
        });

        sendJson({ type: 'ready' });
        return;
      }

      if (payload.type === 'stop') {
        stopChild();
        return;
      }

      if (payload.type === 'ping') {
        sendJson({ type: 'pong' });
        return;
      }

      fail(`Unknown websocket message type: ${payload.type || 'unknown'}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

  ws.on('close', () => {
    if (state.child) {
      try {
        state.child.kill('SIGTERM');
      } catch {}
    }
    cleanupChild();
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`qwen-asr-service listening on http://${HOST}:${PORT}`);
  console.log(`binary=${QWEN_ASR_BIN}`);
  console.log(`model=${QWEN_ASR_MODEL_DIR}`);
});

const wss = new WebSocketServer({ server, path: '/ws/stream' });
wss.on('connection', (ws) => {
  createStreamSession(ws);
});