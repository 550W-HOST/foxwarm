'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs, runArchiveCli } = require('./archive.js');

test('archive frontend keeps strict public options, caller-relative output and backend exit status', async () => {
  for (const args of [[], ['export-jsonl'], ['export-jsonl', '-o'], ['export-jsonl', '-o', 'out', '--unknown']])
    assert.throws(() => parseArgs(args));
  let received;
  const options = {
    backend: async (operation, input, streams) => { received = { operation, input, streams }; return 1; },
  };
  assert.equal(await runArchiveCli(['export-jsonl', '-o', './tmp-export'], options), 1);
  assert.equal(received.operation, 'archive');
  assert.equal(received.input.output, path.resolve('./tmp-export'));
  assert.equal(received.streams, options);
});
