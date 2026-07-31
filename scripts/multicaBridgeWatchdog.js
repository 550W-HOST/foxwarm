#!/usr/bin/env node
'use strict';

let config = null;
let disarmed = false;
let buffer = '';
let finishPromise = null;

function parseLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message?.type === 'init' && !config) {
    if (typeof message.baseUrl === 'string' && typeof message.token === 'string' && typeof message.sessionId === 'string') {
      config = message;
      process.stdout.write('ready\n');
    }
  } else if (message?.type === 'disarm') {
    disarmed = true;
    process.exit(0);
  }
}

async function sendStop() {
  if (!config || disarmed || typeof fetch !== 'function') return;
  const path = `/api/sessions/${encodeURIComponent(config.sessionId)}/message`;
  try {
    await fetch(`${config.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '/stop' }),
    });
  } catch {
    // The watchdog has no logging surface: credentials and server response
    // details must never escape through an orphan process.
  }
}

function finish() {
  if (!finishPromise) {
    finishPromise = (async () => {
      if (buffer.trim()) parseLine(buffer.trim());
      if (!disarmed) await sendStop();
    })();
  }
  return finishPromise;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) parseLine(line);
  }
});
process.stdin.on('end', () => { finish().finally(() => process.exit(0)); });
process.stdin.on('close', () => { finish().finally(() => process.exit(0)); });
process.stdin.on('error', () => { finish().finally(() => process.exit(0)); });
