import assert from 'node:assert/strict';
import test from 'node:test';
import { toolActivitySummary, toolActivityTarget } from './toolActivity';

test('activity resolves qualified Node and MCP tool IDs and encoded inner arguments', () => {
  const call = { name: 'call_tool', args: { toolId: 'node:provider/worker/exec', argsJson: JSON.stringify({ summary: 'Inspect source', command: 'setup; inspect' }) } };
  assert.equal(toolActivityTarget(call).name, 'exec');
  assert.equal(toolActivitySummary(call), 'Inspect source');
  assert.equal(toolActivityTarget({ name: 'call_tool', args: { toolId: 'mcp:server/group/tool', args: {} } }).name, 'group/tool');
  assert.equal(toolActivityTarget({ name: 'call_tool', args: { toolId: 'builtin:run_script', args: {} } }).name, 'run_script');
});

test('legacy command previews retain the literal prefix and bound whole Unicode characters', () => {
  assert.equal(toolActivitySummary({ name: 'exec', args: { command: 'export A=setup;\nprintf work' } }), 'export A=setup; printf work');
  const summary = toolActivitySummary({ name: 'exec', args: { summary: 'x'.repeat(198) + '🦊'.repeat(20) } });
  assert.ok(summary.length <= 200);
  assert.ok(!/[\uD800-\uDBFF]…$/.test(summary));
  assert.equal(toolActivitySummary({ name: 'read', args: { filePath: 'source.ts', content: 'not a preview' } }), 'source.ts');
});
