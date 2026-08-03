#!/usr/bin/env node
'use strict';

const path = require('path');

function printHelp(stream) {
  stream.write(`foxwarm CLI

Usage: foxwarm <subcommand> [options]

Subcommands:
  model    Send one prompt through Foxwarm's configured production model stack
  archive  Export SQLite-authoritative archives as compatibility JSONL

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

module.exports = { printHelp, run };
