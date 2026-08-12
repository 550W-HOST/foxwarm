const assert = require('node:assert/strict');
const test = require('node:test');
const { parseArgs, runStorageCli } = require('./storage.js');

test('storage copy requires explicit quiesced-source acknowledgement', () => {
  assert.throws(() => parseArgs(['journal', 'copy-sqlite-to-postgres', '--sqlite', './source.sqlite']), /source-quiesced/);
  assert.equal(parseArgs(['journal', 'copy-sqlite-to-postgres', '--sqlite', './source.sqlite', '--source-quiesced']).sqlite.endsWith('source.sqlite'), true);
});

test('storage help does not load runtime configuration', async () => {
  const stdout = { value: '', write(value) { this.value += value; } };
  let loaded = false;
  assert.equal(await runStorageCli(['--help'], { stdout, runtimeLoader: () => { loaded = true; throw new Error('should not load'); } }), 0);
  assert.equal(loaded, false);
  assert.match(stdout.value, /fresh empty schema/);
  assert.equal(await runStorageCli(['journal', '--help'], { stdout, runtimeLoader: () => { loaded = true; throw new Error('should not load'); } }), 0);
  assert.equal(loaded, false);
});

test('storage copy dispatches to configured PostgreSQL store and closes it', async () => {
  const calls = [];
  const stdout = { value: '', write(value) { this.value += value; } };
  await runStorageCli(['journal', 'copy-sqlite-to-postgres', '--sqlite', './source.sqlite', '--source-quiesced'], {
    stdout,
    runtimeLoader: () => ({
      LLM_REQUEST_JOURNAL_STORAGE_CONFIG: { backend: 'postgres' },
      createConfiguredLlmRequestJournalStore() { calls.push('store'); return { backend: 'postgres', async close() { calls.push('close'); } }; },
      async copySqliteLlmRequestJournalToStore(source) { calls.push(['copy', source]); return { requests: 1 }; },
    }),
  });
  assert.deepEqual(calls.map(value => Array.isArray(value) ? value[0] : value), ['store', 'copy', 'close']);
  assert.match(stdout.value, /"requests": 1/);
});

test('storage copy closes a directly-created store when copy fails', async () => {
  const calls = [];
  await assert.rejects(runStorageCli(['journal', 'copy-sqlite-to-postgres', '--sqlite', './source.sqlite', '--source-quiesced'], {
    runtimeLoader: () => ({
      LLM_REQUEST_JOURNAL_STORAGE_CONFIG: { backend: 'postgres' },
      createConfiguredLlmRequestJournalStore() { return { backend: 'postgres', async close() { calls.push('close'); } }; },
      async copySqliteLlmRequestJournalToStore() { throw new Error('copy failed'); },
    }),
  }), /copy failed/);
  assert.deepEqual(calls, ['close']);
});