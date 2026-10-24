'use strict';

const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { coreExecutable } = require('./core-executable');

// One parsed-options header, optional prompt stdin and ordinary stdout/stderr.
// These operations never connect to Main or start an HTTP server or Session engine.
async function runCoreCli(operation, input, options = {}) {
  const executable = coreExecutable();
  const windows = process.platform === 'win32';
  const name = windows ? `foxwarm-cli-${randomUUID()}` : '3';
  let connection;
  let lifetime;
  if (windows) {
    lifetime = net.createServer(socket => {
      connection = socket;
      lifetime.close();
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
      lifetime.once('error', reject);
      lifetime.listen(`\\\\.\\pipe\\${name}`, resolve);
    });
  }
  let child;
  try {
    child = spawn(executable.command, [
      ...executable.args, `--cli-${operation}`,
    ], {
      env: { ...process.env, FOXWARM_CLI_LIFETIME_PIPE: name },
      // As with Main, Unix uses an inherited connection without a temporary path.
      stdio: windows ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    if (!windows) {
      connection = child.stdio[3];
      connection.on('error', () => {});
    }
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    child.stdout.on('data', chunk => stdout.write(chunk));
    child.stderr.on('data', chunk => stderr.write(chunk));
    child.stdin.write(JSON.stringify(input) + '\n');
    const stdin = options.stdin || process.stdin;
    if (operation === 'model' && input.prompt === undefined && !input.list && !stdin.isTTY) {
      stdin.pipe(child.stdin);
      child.once('close', () => stdin.unpipe(child.stdin));
    } else child.stdin.end();
    return await new Promise((resolve, reject) => {
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
      child.once('error', error => reject(new Error(`Cannot launch Foxwarm Core: ${error.message}. Install the ASP.NET Core 10 runtime or make dotnet available on PATH.`)));
      child.once('close', (code, signal) => {
        if (signal) reject(new Error(`Foxwarm Core terminated by ${signal}.`));
        else resolve(code ?? 1);
      });
    });
  } finally {
    // A separate pipe stays open after prompt EOF. Even a hard frontend kill
    // closes it in the kernel, so the one-shot backend cannot outlive its caller.
    connection?.destroy();
    if (lifetime?.listening) lifetime.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}

module.exports = { runCoreCli };
