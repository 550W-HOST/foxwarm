#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

class StorageCliUsageError extends Error {}

function printHelp(stream) {
  stream.write(`foxwarm storage\n\nUsage:\n  foxwarm storage journal copy-sqlite-to-postgres --sqlite <path> --source-quiesced\n\nThe source must be quiesced. The PostgreSQL target must be a fresh empty schema.\nA failed/incomplete copy requires dropping that schema or choosing another fresh schema.\n`);
}

function parseArgs(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  if (argv[0] !== 'journal') throw new StorageCliUsageError('Expected `journal`.');
  if (argv[1] === '--help' || argv[1] === '-h') return { help: true };
  if (argv[1] !== 'copy-sqlite-to-postgres') throw new StorageCliUsageError('Expected `copy-sqlite-to-postgres`.');
  if (argv[2] === '--help' || argv[2] === '-h') return { help: true };
  let sqlite;
  let sourceQuiesced = false;
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--sqlite') {
      sqlite = argv[++index];
      if (!sqlite) throw new StorageCliUsageError('--sqlite requires a database path.');
    } else if (option === '--source-quiesced') {
      sourceQuiesced = true;
    } else {
      throw new StorageCliUsageError(`Unknown option: ${option}`);
    }
  }
  if (!sqlite) throw new StorageCliUsageError('--sqlite is required.');
  if (!sourceQuiesced) throw new StorageCliUsageError('--source-quiesced is required; stop all writers before copying.');
  return { sqlite: path.resolve(sqlite), help: false };
}

function loadRuntime() {
  const root = path.dirname(__dirname);
  const required = [
    path.join(root, 'lib', 'config.js'),
    path.join(root, 'lib', 'llmRequestJournalMigration.js'),
    path.join(root, 'lib', 'llmRequestJournalStoreFactory.js'),
  ];
  for (const candidate of required) if (!fs.existsSync(candidate)) throw new Error('Foxwarm build output is missing. Run `npm run build` first.');
  const config = require(required[0]);
  const migration = require(required[1]);
  const factory = require(required[2]);
  return { ...config, ...migration, ...factory };
}

async function runStorageCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const args = parseArgs(argv);
  if (args.help) { printHelp(stdout); return 0; }
  const runtime = options.runtimeLoader ? options.runtimeLoader() : loadRuntime();
  if (runtime.LLM_REQUEST_JOURNAL_STORAGE_CONFIG?.backend !== 'postgres') {
    throw new Error('Configure storage.llmRequestJournal.backend as postgres before running this copy.');
  }
  let target;
  try {
    target = runtime.createConfiguredLlmRequestJournalStore();
    const report = await runtime.copySqliteLlmRequestJournalToStore(args.sqlite, target, runtime.LLM_REQUEST_JOURNAL_STORAGE_CONFIG);
    stdout.write(`${JSON.stringify({ source: args.sqlite, report }, null, 2)}\n`);
  } finally { await target?.close?.(); }
  return 0;
}

module.exports = { StorageCliUsageError, loadRuntime, parseArgs, printHelp, runStorageCli };
