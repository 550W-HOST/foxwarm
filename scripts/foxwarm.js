#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('node:child_process');
const { coreExecutable } = require('./core-executable');

function printHelp(stream) {
  stream.write(`foxwarm CLI

Usage: foxwarm <subcommand> [options]

Subcommands:
  model    Send one prompt through Foxwarm's configured production model stack
  archive  Export SQLite-authoritative archives as compatibility JSONL
  db       Hosted mode: apply or show the database schema (db migrate, db status)
  hosted   Hosted mode: import a file-mode installation (hosted import)

Options:
  -v, --version   Print version
  -h, --help      Show this help
`);
}

// Hosted-mode operator verbs take their arguments and environment as they are and write their
// own output, so the managed binary receives the command line unchanged.
function runPassthrough(argv, streams = {}) {
  const spawnImpl = streams.spawn || spawn;
  const executable = (streams.coreExecutable || coreExecutable)();
  return new Promise(resolve => {
    const child = spawnImpl(executable.command, [...executable.args, ...argv], {
      stdio: ['inherit', streams.stdout ? 'pipe' : 'inherit', streams.stderr ? 'pipe' : 'inherit'],
    });
    if (streams.stdout) child.stdout.pipe(streams.stdout, { end: false });
    if (streams.stderr) child.stderr.pipe(streams.stderr, { end: false });
    child.on('error', error => {
      (streams.stderr || process.stderr).write(`Error: ${error.message}\n`);
      resolve(1);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function run(argv, streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;
  const subcommand = argv[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp(stdout);
    return 0;
  }
  if (subcommand === '--version' || subcommand === '-v') {
    const pkg = require(path.join(path.dirname(__dirname), 'package.json'));
    stdout.write(`${pkg.version || 'unknown'}\n`);
    return 0;
  }
  if (subcommand === 'db' || subcommand === 'hosted') {
    try {
      return await runPassthrough(argv, streams);
    } catch (error) {
      stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (subcommand !== 'model' && subcommand !== 'archive') {
    stderr.write(`Usage error: Unknown subcommand: ${subcommand}\n`);
    return 2;
  }

  const implementation = subcommand === 'model' ? require('./model.js') : require('./archive.js');
  const runner = subcommand === 'model' ? implementation.runModelCli : implementation.runArchiveCli;
  const UsageError = subcommand === 'model' ? implementation.CliUsageError : implementation.ArchiveCliUsageError;
  try {
    return await runner(argv.slice(1), streams);
  } catch (error) {
    const prefix = error instanceof UsageError ? 'Usage error' : 'Error';
    stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

module.exports = { printHelp, run, runPassthrough };
