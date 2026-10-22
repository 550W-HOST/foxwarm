#!/usr/bin/env node
'use strict';

const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { coreExecutable, coreEnvironment } = require('./core-executable');

// This is the package/directory Main execution boundary, not the public foxwarm CLI.
// Keep stdin and terminal ownership unchanged. A separate connection asks Main to
// drain when this foreground launcher is terminated, including a hard parent kill.
async function main() {
  const executable = coreExecutable();
  const windows = process.platform === 'win32';
  const name = windows ? `foxwarm-main-${randomUUID()}` : '3';
  let connection;
  let server;
  let stopping = false;
  if (windows) {
    server = net.createServer(socket => {
      connection = socket;
      socket.on('error', () => {});
      if (stopping) socket.write('stop\n');
      server.close();
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(`\\\\.\\pipe\\${name}`, resolve);
    });
  }
  const stop = () => {
    stopping = true;
    connection?.write('stop\n');
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stop);
  try {
    const child = spawn(executable.command, [...executable.args, ...process.argv.slice(2)], {
      env: { ...coreEnvironment(), FOXWARM_MAIN_LIFETIME_PIPE: name },
      // Unix inherits a separate connected pipe at fd 3: no filesystem address or
      // TMPDIR restriction, and no change to the caller's stdin/stdout/stderr.
      stdio: windows ? 'inherit' : ['inherit', 'inherit', 'inherit', 'pipe'],
      // libuv otherwise places Windows children in its kill-on-parent-exit job.
      // Keep the child referenced and awaited; the lifetime pipe owns normal drain.
      detached: windows,
    });
    if (!windows) {
      connection = child.stdio[3];
      connection.on('error', () => {});
      if (stopping) connection.write('stop\n');
    }
    await new Promise((resolve, reject) => {
      child.once('error', error => reject(new Error(`Cannot launch Foxwarm Main: ${error.message}. Make the .NET 10 ASP.NET Core runtime available on PATH.`)));
      child.once('exit', (code, signal) => {
        process.exitCode = code ?? 1;
        if (signal) {
          // Preserve crash/signal status; ordinary requested shutdown uses Main's exit code.
          for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(name, stop);
          process.kill(process.pid, signal);
        }
        resolve();
      });
    });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop);
    connection?.destroy();
    if (server?.listening) server.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
