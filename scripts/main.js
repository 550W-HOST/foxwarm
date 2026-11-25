#!/usr/bin/env node
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { coreExecutable } = require('./core-executable');

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

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
  const pidFile = path.join(path.dirname(__dirname), 'foxwarm.pid');
  let pid;
  let previousPid;
  let exitSignal;
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
      env: { ...process.env, FOXWARM_MAIN_LIFETIME_PIPE: name },
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
      let pidError;
      child.once('spawn', () => {
        try {
          try {
            previousPid = fs.readFileSync(pidFile, 'utf8');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          fs.writeFileSync(pidFile, `${child.pid}\n`);
          pid = `${child.pid}\n`;
        } catch (error) {
          pidError = error;
          stop();
        }
      });
      child.once('error', error => reject(new Error(`Cannot launch Foxwarm Main: ${error.message}. Make the .NET 10 ASP.NET Core runtime available on PATH.`)));
      child.once('exit', (code, signal) => {
        process.exitCode = code ?? 1;
        exitSignal = signal;
        if (pidError) reject(pidError);
        else resolve();
      });
    });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stop);
    connection?.destroy();
    if (server?.listening) server.close();
    if (pid) {
      try {
        if (fs.readFileSync(pidFile, 'utf8') === pid) {
          // A Main refused by the data-directory lock must not erase the running Main's record.
          if (previousPid && alive(Number(previousPid))) fs.writeFileSync(pidFile, previousPid);
          else fs.unlinkSync(pidFile);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  // Remove the PID file before preserving Main's crash/signal status.
  if (exitSignal) process.kill(process.pid, exitSignal);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
