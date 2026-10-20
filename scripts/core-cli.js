'use strict';

const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { coreExecutable, coreEnvironment } = require('./core-executable');

// One parsed-options header, optional prompt stdin and ordinary stdout/stderr.
// These operations never connect to Main or start an HTTP server or Session engine.
async function runCoreCli(operation, input, options = {}) {
  const executable = coreExecutable();
  const name = `foxwarm-cli-${randomUUID()}`;
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), name);
  let connection;
  const lifetime = net.createServer(socket => {
    connection = socket;
    lifetime.close();
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    lifetime.once('error', reject);
    lifetime.listen(pipe, resolve);
  });
  let child;
  try {
    child = spawn(executable.command, [
      ...executable.args, `--cli-${operation}`,
    ], {
      env: { ...coreEnvironment(),
        FOXWARM_CLI_LIFETIME_PIPE: process.platform === 'win32' ? name : pipe },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    if (lifetime.listening) lifetime.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }
}

module.exports = { runCoreCli };
