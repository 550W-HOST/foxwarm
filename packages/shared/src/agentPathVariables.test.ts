import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { expandAgentPathVariable, rejectUnsupportedAgentPathVariable } from './agentPathVariables';

test('only a leading exact Agent path token expands, never host variables or a middle segment', () => {
  const root = '/agent/owner';
  assert.equal(expandAgentPathVariable('$fw_agentdir', root), root);
  assert.equal(expandAgentPathVariable('$fw_tmp/file.txt', root), path.join(root, 'tmp/file.txt'));
  assert.equal(expandAgentPathVariable('$fw_tmp/../owned.txt', root), path.join(root, 'owned.txt'));
  for (const literal of ['./$fw_tmp/file', 'sub/$fw_tmp/file', '~/file', '/tmp/file', 'file$fw_tmp']) {
    assert.equal(expandAgentPathVariable(literal, root), literal);
  }
  for (const unknown of ['$HOME/foo', '$fw_tmp_suffix/a', '${fw_tmp}/a', '$/foo']) {
    assert.throws(() => expandAgentPathVariable(unknown, root), /Unknown Agent path variable/);
  }
  assert.throws(() => expandAgentPathVariable('$fw_tmp/a'), /unavailable in this execution environment/);
  assert.throws(() => rejectUnsupportedAgentPathVariable('$fw_agentdir/a'), /unavailable in this execution environment/);
  assert.throws(() => rejectUnsupportedAgentPathVariable('$OTHER/a'), /Unknown Agent path variable/);
  rejectUnsupportedAgentPathVariable('./$fw_tmp');
});
