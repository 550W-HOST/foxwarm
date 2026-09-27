#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const CONTROL_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;

function resolveDataRoot(rootDir = ROOT_DIR, env = process.env) {
  const configured = String(env.FOXWARM_DATA_DIR || '').trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured);

  const pointerPath = path.join(rootDir, 'data_dir');
  if (fs.existsSync(pointerPath)) {
    const pointer = fs.readFileSync(pointerPath, 'utf8').trim();
    if (pointer) return path.isAbsolute(pointer) ? pointer : path.resolve(rootDir, pointer);
  }

  return rootDir;
}

function getControlPath(dataRoot, platform = process.platform, tempDir = os.tmpdir()) {
  const normalized = platform === 'win32'
    ? path.resolve(dataRoot).toLowerCase()
    : path.resolve(dataRoot);
  const id = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 20);
  return platform === 'win32'
    ? `\\\\.\\pipe\\foxwarm-${id}`
    : path.join(tempDir, `foxwarm-${id}.sock`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function requestControl(controlPath, command, timeoutMs = CONTROL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    const socket = net.createConnection(controlPath);
    const timer = setTimeout(() => finish(new Error(`Timed out contacting Foxwarm at ${controlPath}`)), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }

    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${command}\n`));
    socket.on('data', chunk => { response += chunk; });
    socket.once('end', () => {
      try {
        finish(undefined, JSON.parse(response));
      } catch (error) {
        finish(new Error(`Invalid response from Foxwarm control pipe: ${error.message}`));
      }
    });
    socket.once('error', error => finish(error));
  });
}

async function queryService(controlPath) {
  try {
    const response = await requestControl(controlPath, 'status');
    return response && response.ok ? response : null;
  } catch {
    return null;
  }
}

async function waitForService(controlPath, expectedRunning, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const status = await queryService(controlPath);
    if (Boolean(status) === expectedRunning) return status;
    await sleep(200);
  } while (Date.now() < deadline);
  return null;
}

function servicePaths(dataRoot) {
  const logDir = path.join(dataRoot, 'state', 'logs');
  return {
    logDir,
    stdoutLog: path.join(logDir, 'foxwarm.stdout.log'),
    stderrLog: path.join(logDir, 'foxwarm.stderr.log'),
  };
}

async function startService(dataRoot, controlPath) {
  const existing = await queryService(controlPath);
  if (existing) {
    console.error(`Foxwarm is already running (PID ${existing.pid}).`);
    return 1;
  }

  const paths = servicePaths(dataRoot);
  fs.mkdirSync(paths.logDir, { recursive: true });
  const stdoutFd = fs.openSync(paths.stdoutLog, 'a');
  const stderrFd = fs.openSync(paths.stderrLog, 'a');
  let child;
  try {
    child = spawn(process.execPath, [__filename, 'run'], {
      cwd: ROOT_DIR,
      detached: true,
      env: {
        ...process.env,
        FOXWARM_DATA_DIR: dataRoot,
        FOXWARM_WINDOWS_STDOUT_LOG: paths.stdoutLog,
        FOXWARM_WINDOWS_STDERR_LOG: paths.stderrLog,
      },
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }

  const status = await waitForService(controlPath, true, START_TIMEOUT_MS);
  if (!status || !isProcessAlive(child.pid)) {
    console.error('Foxwarm did not start. Check:');
    console.error(`  ${paths.stderrLog}`);
    return 1;
  }

  console.log(`Foxwarm started in the background (PID ${status.pid}).`);
  console.log(`Data:   ${dataRoot}`);
  console.log(`Output: ${paths.stdoutLog}`);
  console.log(`Errors: ${paths.stderrLog}`);
  return 0;
}

async function stopService(controlPath) {
  const current = await queryService(controlPath);
  if (!current) {
    console.log('Foxwarm is not running.');
    return 0;
  }

  let response;
  try {
    response = await requestControl(controlPath, 'stop');
  } catch (error) {
    console.error(`Failed to request Foxwarm shutdown: ${error.message}`);
    return 1;
  }

  const pid = Number(response.pid || current.pid);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(200);

  if (isProcessAlive(pid)) {
    console.warn(`Graceful shutdown timed out; terminating PID ${pid}.`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      console.error(`Failed to terminate PID ${pid}: ${error.message}`);
      return 1;
    }
  }

  console.log('Foxwarm stopped.');
  return 0;
}

function runService(dataRoot, controlPath) {
  if (process.platform !== 'win32') {
    console.error('The background service launcher is for Windows. Use scripts/start.sh on this platform.');
    process.exit(1);
  }

  const paths = servicePaths(dataRoot);
  let stopping = false;
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.on('error', error => {
      console.error(`[windows-service] Control client error: ${error.message}`);
    });
    socket.once('data', rawCommand => {
      const command = rawCommand.trim();
      if (command === 'status') {
        socket.end(JSON.stringify({ ok: true, pid: process.pid, stopping, ...paths }));
        return;
      }
      if (command === 'stop') {
        socket.end(JSON.stringify({ ok: true, pid: process.pid }));
        if (!stopping) {
          stopping = true;
          setImmediate(() => process.emit('SIGTERM'));
        }
        return;
      }
      socket.end(JSON.stringify({ ok: false, error: 'unknown command' }));
    });
  });

  server.once('error', error => {
    console.error(`Foxwarm control pipe failed: ${error.stack || error.message}`);
    process.exit(1);
  });
  server.listen(controlPath, () => {
    console.log(`[windows-service] Control pipe ready for PID ${process.pid}`);
    require(path.join(ROOT_DIR, 'lib', 'index.js'));
  });
}

async function main() {
  const command = process.argv[2] || 'status';
  const dataRoot = resolveDataRoot();
  const controlPath = getControlPath(dataRoot);

  if (command === 'run') {
    runService(dataRoot, controlPath);
    return;
  }
  if (process.platform !== 'win32') {
    console.error('Windows service commands are only supported on Windows.');
    process.exitCode = 1;
    return;
  }
  if (command === 'start') {
    process.exitCode = await startService(dataRoot, controlPath);
    return;
  }
  if (command === 'check-stopped') {
    const status = await queryService(controlPath);
    if (status) {
      console.error(`Foxwarm is already running (PID ${status.pid}). Use restart:windows instead.`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'stop') {
    process.exitCode = await stopService(controlPath);
    return;
  }
  if (command === 'restart') {
    const stopCode = await stopService(controlPath);
    process.exitCode = stopCode || await startService(dataRoot, controlPath);
    return;
  }
  if (command === 'status') {
    const status = await queryService(controlPath);
    if (!status) {
      console.log('Foxwarm is not running.');
      process.exitCode = 1;
      return;
    }
    console.log(`Foxwarm is running (PID ${status.pid}${status.stopping ? ', stopping' : ''}).`);
    console.log(`Data:   ${dataRoot}`);
    console.log(`Output: ${status.stdoutLog}`);
    console.log(`Errors: ${status.stderrLog}`);
    return;
  }

  console.error('Usage: node scripts/windowsService.js <start|restart|stop|status>');
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { getControlPath, requestControl, resolveDataRoot, servicePaths };
