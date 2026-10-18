#!/usr/bin/env node
'use strict';

const path = require('path');
const { runCoreCli } = require('./core-cli.js');

class ArchiveCliUsageError extends Error {}

function parseArgs(argv) {
  if (argv[0] !== 'export-jsonl') throw new ArchiveCliUsageError('Expected `export-jsonl`.');
  let output;
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--output' || argv[index] === '-o') {
      output = argv[++index];
      if (!output) throw new ArchiveCliUsageError('--output requires a directory.');
    } else {
      throw new ArchiveCliUsageError(`Unknown option: ${argv[index]}`);
    }
  }
  if (!output) throw new ArchiveCliUsageError('--output is required.');
  return { output: path.resolve(output) };
}

async function runArchiveCli(argv, options = {}) {
  const input = parseArgs(argv);
  return (options.backend || runCoreCli)('archive', input, options);
}

module.exports = { ArchiveCliUsageError, parseArgs, runArchiveCli };
