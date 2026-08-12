'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs, runArchiveCli } = require('./archive.js');

test('archive export CLI validates output and invokes SQLite-backed exporters', async () => {
  assert.throws(() => parseArgs(['export-jsonl']), /--output is required/);
  const calls = [];
  let text = '';
  const code = await runArchiveCli(['export-jsonl', '--output', './tmp-export'], {
    stdout: { write(value) { text += value; } },
    runtimeLoader: () => ({
      async runSqliteOnlyArchivesMigration() { calls.push('migrate'); },
      async exportSessionArchivesJsonl(output) { calls.push(['sessions', output]); return { files: 1, records: 2 }; },
      async exportLlmRequestJournalJsonl(output) { calls.push(['llm', output]); return { records: 3 }; },
      async shutdownLlmRequestJournal() { calls.push('close-llm'); },
    }),
  });
  assert.equal(code, 0);
  assert.equal(calls[0], 'migrate');
  assert.equal(calls[1][0], 'sessions');
  assert.equal(path.basename(calls[2][1]), 'llm-request-journal.jsonl');
  assert.equal(calls[3], 'close-llm');
  assert.match(text, /"records": 3/);
});
