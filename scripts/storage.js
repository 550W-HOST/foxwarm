#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

class StorageCliUsageError extends Error {}

function parseArgs(argv) {
  if (argv[0] !== 'journal') throw new StorageCliUsageError('Expected `journal`.');
  if (argv[1] !== 'copy-sqlite-to-postgres') throw new StorageCliUsageError('Expected `copy-sqlite-to-postgres`.');
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
  return { sqlite: path.resolve(sqlite) };
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
  const runtime = options.runtimeLoader ? options.runtimeLoader() : loadRuntime();
  const args = parseArgs(argv);
  if (runtime.LLM_REQUEST_JOURNAL_STORAGE_CONFIG?.backend !== 'postgres') {
    throw new Error('Configure storage.llmRequestJournal.backend as postgres before running this copy.');
  }
  let target;
  try {
    target = await runtime.getLlmRequestJournalStore();
    const report = await runtime.copySqliteLlmRequestJournalToStore(args.sqlite, target);
    stdout.write(`${JSON.stringify({ source: args.sqlite, report }, null, 2)}\n`);
  } finally {
    await runtime.closeLlmRequestJournalStore?.();
  }
  return 0;
}

module.exports = { StorageCliUsageError, loadRuntime, parseArgs, runStorageCli };
