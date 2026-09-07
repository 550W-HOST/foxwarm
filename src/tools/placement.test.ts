import test from 'node:test';
import assert from 'node:assert/strict';

import { CLI_NODE_CAPABILITIES } from '../../packages/shared/dist/nodeCapabilities';
import * as tools from '../tools';
import { definitions } from './definitions';
import {
  builtinNodeArgumentSelectsPlacement,
  BUILTIN_TOOL_PLACEMENTS,
  NODE_ENVIRONMENT_BUILTIN_NAMES,
  resolveBuiltinToolPlacement,
} from './placement';
import { resolveDirectTool } from './resolvedTools';

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
  for (const action of ['list', 'create', 'ensure', 'inspect', 'destroy']) {
    assert.deepEqual(resolveBuiltinToolPlacement('node', { action }, 'remote-node'), {
      name: 'node', owner: 'main-management', executionNode: 'master',
    });
  }
  assert.deepEqual(resolveBuiltinToolPlacement('node', { action: 'select' }, 'remote-node'), {
    name: 'node', owner: 'dispatcher/container', executionNode: 'master',
  });
  assert.deepEqual(resolveBuiltinToolPlacement('provider_returned_unknown_tool', {}, 'remote-node'), {
    name: 'provider_returned_unknown_tool',
    owner: 'dispatcher/container',
    executionNode: 'master',
  });
});

test('only file source/target node arguments select builtin placement', async () => {
  const rootNodeSchemas = definitions
    .filter(definition => Object.prototype.hasOwnProperty.call(definition.parameters?.properties || {}, 'node'))
    .map(definition => definition.name)
    .sort();
  assert.deepEqual(rootNodeSchemas, ['create_child_session', 'image_write_to_file', 'send_file']);
  assert.equal(builtinNodeArgumentSelectsPlacement('image_write_to_file'), true);
  assert.equal(builtinNodeArgumentSelectsPlacement('send_file'), true);
  assert.equal(builtinNodeArgumentSelectsPlacement('create_child_session'), false);

  const session = { id: 'placement-parent', agent: 'main', currentNode: 'parent-node' };
  const child = await resolveDirectTool('create_child_session', {
    suffix: 'child', node: 'child-node', confirmation: 'test-only resolver input',
  }, { sessionId: session.id, session });
  assert.equal(child.executionNode, 'master');
  assert.equal(child.permissionNode, 'master');
  assert.equal(child.targetNode, undefined);
  assert.equal(child.args.node, 'child-node');

  for (const name of ['image_write_to_file', 'send_file']) {
    const resolved = await resolveDirectTool(name, { node: 'file-node' }, { sessionId: session.id, session });
    assert.equal(resolved.executionNode, 'master');
    assert.equal(resolved.permissionNode, 'file-node');
    assert.equal(resolved.targetNode, 'file-node');
    assert.equal(Object.prototype.hasOwnProperty.call(resolved.args, 'node'), false);

    for (const currentAlias of ['current', '   ']) {
      const currentResolved = await resolveDirectTool(name, { node: currentAlias }, { sessionId: session.id, session });
      assert.equal(currentResolved.permissionNode, 'parent-node');
      assert.equal(currentResolved.targetNode, 'parent-node');
      assert.equal(Object.prototype.hasOwnProperty.call(currentResolved.args, 'node'), false);
    }
  }
});

test('delete_file is absent from runtime exports and unified builtin discovery', async () => {
  assert.equal((tools as any).delete_file, undefined);
  const result: any = await tools.search_tools({
    query: 'delete_file',
    sources: ['builtin'],
    includeSchema: true,
    limit: 200,
  });
  assert.equal(result.output.includes('builtin:delete_file('), false);
});
