#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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

function loadRuntime() {
  const root = path.dirname(__dirname);
  const archiveStorePath = path.join(root, 'lib', 'session', 'archiveStore.js');
  const journalPath = path.join(root, 'lib', 'llmRequestJournal.js');
  const migrationsPath = path.join(root, 'lib', 'migrations', 'index.js');
  for (const candidate of [archiveStorePath, journalPath, migrationsPath]) {
    if (!fs.existsSync(candidate)) throw new Error('Foxwarm build output is missing. Run `npm run build` first.');
  }
  return {
    ...require(archiveStorePath),
    ...require(journalPath),
    ...require(migrationsPath),
  };
}

async function runArchiveCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const runtime = options.runtimeLoader ? options.runtimeLoader() : loadRuntime();
  const { output } = parseArgs(argv);
  await runtime.runSqliteOnlyArchivesMigration();
  const sessions = await runtime.exportSessionArchivesJsonl(path.join(output, 'sessions'));
  const llm = await runtime.exportLlmRequestJournalJsonl(path.join(output, 'llm-request-journal.jsonl'));
  stdout.write(`${JSON.stringify({ output, sessions, llm }, null, 2)}\n`);
  return 0;
}

module.exports = { ArchiveCliUsageError, loadRuntime, parseArgs, runArchiveCli };
