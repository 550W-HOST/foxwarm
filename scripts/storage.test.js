const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, runStorageCli } = require('./storage.js');

test('storage copy requires explicit quiesced-source acknowledgement', () => {
  assert.throws(() => parseArgs(['journal', 'copy-sqlite-to-postgres', '--sqlite', './source.sqlite']), /source-quiesced/);
  assert.equal(parseArgs(['journal', 'copy-sqlite-to-postgres', '--sqlite', './source.sqlite', '--source-quiesced']).sqlite.endsWith('source.sqlite'), true);
});

test('storage copy dispatches to configured PostgreSQL store and closes it', async () => {
  const calls = [];
  const stdout = { value: '', write(value) { this.value += value; } };
  await runStorageCli(['journal', 'copy-sqlite-to-postgres', '--sqlite', './source.sqlite', '--source-quiesced'], {
    stdout,
    runtimeLoader: () => ({
      LLM_REQUEST_JOURNAL_STORAGE_CONFIG: { backend: 'postgres' },
      async getLlmRequestJournalStore() { calls.push('store'); return { backend: 'postgres' }; },
      async copySqliteLlmRequestJournalToStore(source) { calls.push(['copy', source]); return { requests: 1 }; },
      async closeLlmRequestJournalStore() { calls.push('close'); },
    }),
  });
  assert.deepEqual(calls.map(value => Array.isArray(value) ? value[0] : value), ['store', 'copy', 'close']);
  assert.match(stdout.value, /"requests": 1/);
});