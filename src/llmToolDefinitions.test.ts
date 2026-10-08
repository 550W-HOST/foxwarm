import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionToolDefinitions } from './llm';
import * as tools from './tools';
import * as nodeExecution from './nodeExecution';
import { checkToolPermissionForSession, isToolVisibleForSession } from './isolatedCheck';
import { installAgentMetadataSnapshotForWorker, resetAgentMetadataForTests } from './session/agentMetadata';
import {
  buildToolAuthorizationRequest,
  isToolAuthorizationPotentiallyVisibleSync,
  isToolAuthorizationPolicyUnavailable,
  parseToolAuthorizationPolicyBytes,
  setToolAuthorizationPolicyForTests,
  setToolAuthorizationPolicyPathForTests,
} from './toolAuthorization';
import { addToolCancellationSchema } from './toolCallControls';
import type { Session, ToolDefinition } from './types';

const originalTopology = nodeExecution.listNodeTopology;
const scratchDirs: string[] = [];
function unavailablePolicy(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tool-policy-'));
  scratchDirs.push(dir);
  const file = path.join(dir, 'invalid-policy.yaml');
  fs.writeFileSync(file, 'version: unsupported\n');
  setToolAuthorizationPolicyForTests(undefined);
  setToolAuthorizationPolicyPathForTests(file);
}
const session = (id = 'model-worker/main', currentNode = 'master'): Session => ({
  id, agent: id.split('/')[0], currentNode, history: [],
} as Session);
const names = (definitions: ToolDefinition[]) => definitions.map(tool => tool.name);
const policy = (rules: string, defaultAction = 'allow') => setToolAuthorizationPolicyForTests(
  parseToolAuthorizationPolicyBytes(`version: 1\ndefaultAction: ${defaultAction}\nrules:\n${rules}`),
);

test.beforeEach(() => {
  // Keep these tests independent of Node connectivity and persisted policy files.
  (nodeExecution as any).listNodeTopology = async (): Promise<any[]> => [];
  setToolAuthorizationPolicyForTests({ version: 1, defaultAction: 'allow', rules: [] });
});
test.afterEach(async () => {
  (nodeExecution as any).listNodeTopology = originalTopology;
  setToolAuthorizationPolicyForTests(undefined);
  setToolAuthorizationPolicyPathForTests(undefined);
  resetAgentMetadataForTests();
  for (const dir of scratchDirs.splice(0)) await fs.remove(dir);
});

test('default definitions honor non-isolated Session and Agent identity without changing the shared registry', async () => {
  const original = [...tools.modelFacingDefinitions];
  policy(`- id: deny-one-session
  match: { session: model-worker/main, tool: { source: builtin, name: task } }
  action: deny
- id: deny-one-agent
  match: { agent: model-worker, tool: { source: builtin, name: run_script } }
  action: deny
- id: deny-default-planner
  match: { session: model-worker/main, tool: { source: builtin, name: submit_compact_plan } }
  action: deny`);
  const first = await resolveSessionToolDefinitions(session());
  assert.deepEqual(first, original.filter(tool => !['task', 'run_script', 'submit_compact_plan'].includes(tool.name)));
  const sibling = await resolveSessionToolDefinitions(session('model-worker/sibling'));
  assert.ok(names(sibling).includes('task'));
  assert.ok(!names(sibling).includes('run_script'));
  const other = await resolveSessionToolDefinitions(session('other-worker/main'));
  assert.deepEqual(other, original);
  assert.deepEqual(tools.modelFacingDefinitions, original);
  for (const definition of first) assert.strictEqual(definition, original.find(tool => tool.name === definition.name));
  await assert.rejects(checkToolPermissionForSession(session(), { source: 'builtin', tool: 'task' }), /denies/i);
});

test('default-deny preserves permission-neutral call_tool but does not exempt script containers', async () => {
  policy(`- id: allow-read
  match: { tool: { source: node, name: read }, targetNode: master }
  action: allow
- id: ignored-dispatcher-deny
  match: { tool: { source: builtin, name: call_tool } }
  action: deny`, 'deny');
  const visible = names(await resolveSessionToolDefinitions(session()));
  assert.deepEqual(visible, names(tools.modelFacingDefinitions).filter(name => ['read', 'call_tool'].includes(name)));
  assert.ok(!visible.includes('run_script'));
});

test('default definition projection preserves ordered conditional and unconditional decisions', async () => {
  const cases = [
    { defaultAction: 'deny', expected: true, rules: `- id: allow-conditional
  match: { tool: read, args: { filePath: allowed } }
  action: allow
- id: catch-all-deny
  match: { tool: read }
  action: deny` },
    { defaultAction: 'allow', expected: true, rules: `- id: deny-conditional
  match: { tool: read, args: { filePath: forbidden } }
  action: deny` },
    { defaultAction: 'deny', expected: true, rules: `- id: allow-path
  match: { tool: read, path: { allWithin: "\${agent.dir}" } }
  action: allow` },
    { defaultAction: 'allow', expected: false, rules: `- id: first-deny
  match: { tool: read }
  action: deny
- id: later-conditional-allow
  match: { tool: read, args: { filePath: allowed } }
  action: allow` },
    { defaultAction: 'deny', expected: true, rules: `- id: first-allow
  match: { tool: read }
  action: allow
- id: later-deny
  match: { tool: read }
  action: deny` },
  ];
  for (const entry of cases) {
    policy(entry.rules, entry.defaultAction);
    assert.equal(names(await resolveSessionToolDefinitions(session())).includes('read'), entry.expected, entry.rules);
  }
});

test('Node primitives use the current concrete Node; ordinary builtins use resolved master placement', async () => {
  policy(`- id: deny-node-a-files
  match: { tool: { source: node, name: [read, write, edit, apply_patch, exec] }, targetNode: node-a }
  action: deny
- id: deny-master-builtin
  match: { tool: { source: builtin, name: task }, targetNode: master }
  action: deny`);
  const owner = session('model-worker/main', 'node-a');
  const before = names(await resolveSessionToolDefinitions(owner));
  for (const name of ['read', 'write', 'edit', 'apply_patch', 'exec', 'task']) assert.ok(!before.includes(name), name);
  owner.currentNode = 'node-b';
  const after = names(await resolveSessionToolDefinitions(owner));
  for (const name of ['read', 'write', 'edit', 'apply_patch', 'exec']) assert.ok(after.includes(name), name);
  assert.ok(!after.includes('task'));
});

test('unsupplied file Node selectors retain potential targets without changing concrete discovery', async () => {
  policy(`- id: deny-master-file-builtins
  match: { tool: { source: builtin, name: [send_file, image_write_to_file] }, targetNode: master }
  action: deny`);
  const owner = session();
  const visible = names(await resolveSessionToolDefinitions(owner));
  for (const name of ['send_file', 'image_write_to_file']) {
    assert.ok(visible.includes(name));
    assert.equal(isToolVisibleForSession(owner, { source: 'builtin', tool: name }, 'master'), false);
    assert.equal(isToolVisibleForSession(owner, { source: 'builtin', tool: name }, 'node-a'), true);
    await assert.rejects(checkToolPermissionForSession(owner, { source: 'builtin', tool: name }, 'master'), /denies/i);
    await checkToolPermissionForSession(owner, { source: 'builtin', tool: name }, 'node-a');
  }
  policy(`- id: allow-bound-target
  match: { tool: send_file, targetNode: node-a }
  action: allow
- id: deny-other-targets
  match: { tool: send_file }
  action: deny`, 'deny');
  assert.ok(names(await resolveSessionToolDefinitions(owner)).includes('send_file'));
  policy(`- id: deny-all-targets
  match: { tool: send_file }
  action: deny
- id: allow-later-target
  match: { tool: send_file, targetNode: node-a }
  action: allow`, 'allow');
  assert.ok(!names(await resolveSessionToolDefinitions(owner)).includes('send_file'));
});

test('unknown target projection cannot turn a conditional deny into whole-tool denial', () => {
  policy(`- id: deny-one-target
  match: { tool: send_file, targetNode: master }
  action: deny`);
  const request = buildToolAuthorizationRequest({ session: session(), tool: { source: 'builtin', name: 'send_file' } });
  assert.equal(isToolAuthorizationPotentiallyVisibleSync(request), false);
  assert.equal(isToolAuthorizationPotentiallyVisibleSync(request, { targetNodeUnknown: true }), true);
});

test('isolated file builtins remain visible when master is denied but their bound Node is permitted', async () => {
  installAgentMetadataSnapshotForWorker('model-worker', { isolated: true, isolatedNode: 'bound-node' });
  const owner = session('model-worker/main', 'master');
  policy(`- id: deny-master-files
  match: { tool: { source: builtin, name: [send_file, image_write_to_file] }, targetNode: master }
  action: deny`);
  for (const name of ['send_file', 'image_write_to_file']) {
    assert.ok(names(await resolveSessionToolDefinitions(owner)).includes(name));
    await assert.rejects(checkToolPermissionForSession(owner, { source: 'builtin', tool: name }, 'master'), /denies/i);
    await checkToolPermissionForSession(owner, { source: 'builtin', tool: name }, 'bound-node');
  }
  policy(`- id: deny-all-file-targets
  match: { tool: { source: builtin, name: [send_file, image_write_to_file] } }
  action: deny`);
  const visible = names(await resolveSessionToolDefinitions(owner));
  assert.ok(!visible.includes('send_file'));
  assert.ok(!visible.includes('image_write_to_file'));
});

test('target-independent isolated builtin denies still hide file tools with unsupplied Node selectors', async () => {
  installAgentMetadataSnapshotForWorker('model-worker', {
    isolated: true, isolatedNode: 'bound-node',
    toolRules: ['send_file', 'image_write_to_file'].map(tool => ({ effect: 'deny' as const, source: 'builtin' as const, tool })),
  });
  const owner = session();
  const visible = names(await resolveSessionToolDefinitions(owner));
  for (const name of ['send_file', 'image_write_to_file']) {
    assert.ok(!visible.includes(name));
    for (const node of ['master', 'bound-node']) {
      await assert.rejects(checkToolPermissionForSession(owner, { source: 'builtin', tool: name }, node), /Agent tool rule denies/i);
    }
  }
});

test('known isolated structural restrictions still remove ordinary default definitions', async () => {
  installAgentMetadataSnapshotForWorker('model-worker', { isolated: true, isolatedNode: 'bound-node' });
  const visible = names(await resolveSessionToolDefinitions(session()));
  assert.ok(!visible.includes('exec'));
  assert.ok(!visible.includes('create_child_session'));
  assert.ok(!visible.includes('list_agents'));
  assert.ok(visible.includes('read'));
  assert.ok(visible.includes('call_tool'));
});

test('Shell exec keeps its advertised schema and cancellation controls after authorization filtering', async () => {
  const capability: ToolDefinition = {
    name: 'exec', description: 'Synthetic bounded Shell execution capability.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', maximum: 20 } }, required: ['command'] },
  };
  (nodeExecution as any).listNodeTopology = async () => [{ type: 'shell-node', tools: [capability] }];
  const owner = session('model-worker/main', 'shell-fixture');
  const visible = await resolveSessionToolDefinitions(owner);
  assert.deepEqual(visible.find(tool => tool.name === 'exec'), addToolCancellationSchema(capability));
  policy(`- id: deny-shell-exec
  match: { tool: { source: node, name: exec }, targetNode: shell-fixture }
  action: deny`);
  assert.ok(!names(await resolveSessionToolDefinitions(owner)).includes('exec'));
  (nodeExecution as any).listNodeTopology = async () => [{ type: 'shell-node', tools: [] as ToolDefinition[] }];
  setToolAuthorizationPolicyForTests({ version: 1, defaultAction: 'allow', rules: [] });
  assert.ok(!names(await resolveSessionToolDefinitions(owner)).includes('exec'));
});

test('topology lookup failures preserve filtered definitions, while unavailable policy fails before topology', async () => {
  let lookups = 0;
  (nodeExecution as any).listNodeTopology = async () => { lookups++; throw new Error('offline topology'); };
  policy(`- id: deny-exec
  match: { tool: { source: node, name: exec } }
  action: deny`);
  assert.ok(!names(await resolveSessionToolDefinitions(session('model-worker/main', 'shell-fixture'))).includes('exec'));
  assert.equal(lookups, 1);
  unavailablePolicy();
  await assert.rejects(resolveSessionToolDefinitions(session('model-worker/main', 'shell-fixture')), isToolAuthorizationPolicyUnavailable);
  assert.equal(lookups, 1);
});

test('explicit overrides retain their specialized request contract even when default policy is unavailable', async () => {
  unavailablePolicy();
  await assert.rejects(resolveSessionToolDefinitions(session()), isToolAuthorizationPolicyUnavailable);
  const override: ToolDefinition[] = [{ name: 'submit_compact_plan', description: 'Synthetic compact plan.', parameters: { type: 'object', properties: {} } }];
  assert.strictEqual(await resolveSessionToolDefinitions(session(), override), override);
  const empty: ToolDefinition[] = [];
  assert.strictEqual(await resolveSessionToolDefinitions(session(), empty), empty);
});
