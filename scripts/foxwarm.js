#!/usr/bin/env node
'use strict';

const path = require('path');

function printHelp(stream) {
  stream.write(`foxwarm CLI

Usage: foxwarm <subcommand> [options]

Subcommands:
  model    Send one prompt through Foxwarm's configured production model stack
  archive  Export SQLite-authoritative archives as compatibility JSONL
  storage  Copy/verify pluggable storage backends

Options:
  -v, --version   Print version
  -h, --help      Show this help
`);
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
  if (subcommand !== 'model' && subcommand !== 'archive' && subcommand !== 'storage') {
    stderr.write(`Usage error: Unknown subcommand: ${subcommand}\n`);
    return 2;
  }

  const implementation = subcommand === 'model' ? require('./model.js') : subcommand === 'archive' ? require('./archive.js') : require('./storage.js');
  const runner = subcommand === 'model' ? implementation.runModelCli : subcommand === 'archive' ? implementation.runArchiveCli : implementation.runStorageCli;
  const UsageError = subcommand === 'model' ? implementation.CliUsageError : subcommand === 'archive' ? implementation.ArchiveCliUsageError : implementation.StorageCliUsageError;
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

module.exports = { printHelp, run };
