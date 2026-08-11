import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_NODE_CAPABILITIES } from '../../packages/shared/dist/nodeCapabilities';
import * as tools from '../tools';
import { definitions } from './definitions';
import {
  BUILTIN_TOOL_PLACEMENTS,
  NODE_ENVIRONMENT_BUILTIN_NAMES,
  resolveBuiltinToolPlacement,
} from './placement';

const EXPECTED_NODE_ENVIRONMENT_TOOLS = [
  'apply_patch',
  'browse_close',
  'browse_get',
  'browse_interact',
  'browse_list',
  'browse_open',
  'edit',
  'exec',
  'read',
  'write',
];

test('every registered builtin has exactly one placement metadata entry', () => {
  const definitionNames = definitions.map(definition => definition.name).sort();
  const placementNames = Object.keys(BUILTIN_TOOL_PLACEMENTS).sort();
  assert.deepEqual(placementNames, definitionNames);
  assert.equal(definitionNames.includes('delete_file'), false);
});

test('node-environment builtins are intentional and match applicable CLI node capabilities', () => {
  const placementNames = [...NODE_ENVIRONMENT_BUILTIN_NAMES].sort();
  assert.deepEqual(placementNames, EXPECTED_NODE_ENVIRONMENT_TOOLS);

  const cliNames = CLI_NODE_CAPABILITIES.tools.map(tool => tool.name).sort();
  assert.equal(cliNames.includes('get_default_cwd'), true, 'get_default_cwd remains a node-only capability');
  assert.deepEqual(
    cliNames.filter(name => name !== 'get_default_cwd'),
    EXPECTED_NODE_ENVIRONMENT_TOOLS,
  );
});

test('placement resolution routes only node-environment tools to currentNode', () => {
  assert.deepEqual(resolveBuiltinToolPlacement('read', {}, 'remote-node'), {
    name: 'read',
    owner: 'node-environment',
    executionNode: 'remote-node',
  });
  assert.deepEqual(resolveBuiltinToolPlacement('set_session_compact_threshold', {}, 'remote-node'), {
    name: 'set_session_compact_threshold',
    owner: 'session-owner',
    executionNode: 'master',
  });
  assert.deepEqual(resolveBuiltinToolPlacement('session', {}, 'remote-node'), {
    name: 'session',
    owner: 'session-owner',
    executionNode: 'master',
  });
  assert.deepEqual(resolveBuiltinToolPlacement('session', { action: 'list' }, 'remote-node'), {
    name: 'session',
    owner: 'main-management',
    executionNode: 'master',
  });
  assert.deepEqual(resolveBuiltinToolPlacement('provider_returned_unknown_tool', {}, 'remote-node'), {
    name: 'provider_returned_unknown_tool',
    owner: 'dispatcher/container',
    executionNode: 'master',
  });
});

test('delete_file is absent from runtime exports and unified builtin discovery', async () => {
  assert.equal((tools as any).delete_file, undefined);
  const result: any = await tools.search_tools({
    query: 'delete_file',
    sources: ['builtin'],
    includeSchema: true,
    limit: 200,
  });
  assert.equal(result.tools.some((tool: any) => tool.name === 'delete_file'), false);
});
