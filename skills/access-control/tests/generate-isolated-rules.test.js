require('../../../scripts/test/test-process-env.cjs').initializeTestEnvironment();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const yaml = require('js-yaml');

// All engine configuration and fixtures stay in this test's disposable root.
const scratch = fs.mkdtempSync(path.join(process.env.fw_tmp || os.tmpdir(), 'isolated-rules-test-'));
process.env.FOXWARM_DATA_DIR = path.join(scratch, 'data');
const repo = path.resolve(__dirname, '../../..');
const script = path.join(repo, 'skills/access-control/scripts/generate-isolated-rules.mjs');
const auth = require(path.join(repo, 'lib/toolAuthorization.js'));
const targets = require(path.join(repo, 'lib/toolAuthorizationSessionTargets.js'));
const guards = require(path.join(repo, 'lib/isolatedCheck.js'));
const sessions = require(path.join(repo, 'lib/sessionManager.js'));
const metadata = require(path.join(repo, 'lib/session/agentMetadata.js'));
const config = require(path.join(repo, 'lib/config.js'));
const skills = require(path.join(repo, 'lib/skills.js'));
let generate;
let policy;
const caller = { id: 'reviewer/work', agent: 'reviewer', parentSessionId: 'coordinator/main' };
const catalog = {
  [caller.id]: caller,
  'reviewer/sibling': { id: 'reviewer/sibling', agent: 'reviewer' },
  'coordinator/main': { id: 'coordinator/main', agent: 'coordinator' },
  'other/child': { id: 'other/child', agent: 'other', parentSessionId: caller.id },
  'other/unrelated': { id: 'other/unrelated', agent: 'other' },
};
catalog.alias = caller;
const originalCatalog = sessions.getSessionCatalog;

test.before(async () => {
  ({ generateIsolatedRules: generate } = await import(pathToFileURL(script).href));
  policy = auth.parseToolAuthorizationPolicyBytes(yaml.dump({
    version: 1, defaultAction: 'allow', ...generate({ reviewer: 'node-a', local: null }),
  }));
  sessions.getSessionCatalog = id => catalog[id];
  fs.mkdirSync(config.getAgentDir(caller.agent), { recursive: true });
  fs.mkdirSync(config.getAgentMemoryDir(caller.agent), { recursive: true });
  assert.equal(metadata.isSessionEffectivelyIsolated(caller), false);
});
test.after(() => {
  sessions.getSessionCatalog = originalCatalog;
  auth.setToolAuthorizationPolicyForTests(undefined);
  fs.rmSync(scratch, { recursive: true, force: true });
});

function request(name, args = {}, source = 'builtin', targetNode = 'master', session = caller) {
  const req = auth.buildToolAuthorizationRequest({ session, tool: { source, name }, targetNode, args });
  targets.populateToolAuthorizationSessionTargets(req, session);
  return req;
}
function decision(name, args, source, node, session) {
  return auth.evaluateToolAuthorizationPolicy(policy, request(name, args, source, node, session)).action;
}

test('CLI emits only a fragment, validates input, and has no policy-install side effect', () => {
  const input = path.join(scratch, 'mapping.json');
  fs.writeFileSync(input, JSON.stringify({ reviewer: 'node-a', local: null }));
  const cli = spawnSync(process.execPath, [script, input], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const fragment = yaml.load(cli.stdout);
  assert.deepEqual(Object.keys(fragment), ['rules']);
  assert.doesNotThrow(() => auth.parseToolAuthorizationPolicyBytes(yaml.dump({ version: 1, ...fragment })));
  assert.equal(fs.existsSync(auth.TOOL_AUTH_CONFIG_PATH), false);
  fs.writeFileSync(input, '[]');
  const bad = spawnSync(process.execPath, [script, input], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.throws(() => generate({ reviewer: '' }), /Node/);
  assert.throws(() => generate({ reviewer: false }), /Node/);
  assert.throws(() => generate({}), /at least one/);
  assert.throws(() => generate(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`agent-${i}`, 'node-a']))), /256/);
});

test('non-isolated callers are constrained by source, Node, all master patch paths, and memory paths', async () => {
  auth.setToolAuthorizationPolicyForTests(policy);
  const own = path.join(config.getAgentDir('reviewer'), 'notes.md');
  await guards.checkToolPermissionForSession(caller, { source: 'node', tool: 'write', node: 'master' }, 'master', { filePath: own });
  await assert.rejects(() => guards.checkToolPermissionForSession(caller, { source: 'node', tool: 'write', node: 'master' }, 'master', { filePath: path.join(scratch, 'outside.md') }), /denies/);
  await guards.checkToolPermissionForSession(caller, { source: 'node', tool: 'exec', node: 'node-a' }, 'node-a', { command: 'true' });
  await assert.rejects(() => guards.checkToolPermissionForSession(caller, { source: 'node', tool: 'exec', node: 'master' }, 'master', { command: 'true' }), /denies/);
  assert.equal(decision('exec', {}, 'node', 'node-b'), 'deny');
  assert.equal(decision('read', { filePath: own }, 'mcp', 'node-a'), 'deny');
  const patch = `*** Begin Patch\n*** Add File: ${own}\n+note\n*** End Patch`;
  assert.equal(decision('apply_patch', { input: patch }, 'node'), 'allow');
  assert.equal(decision('apply_patch', { input: patch.replace('*** End Patch', `*** Delete File: ${path.join(scratch, 'outside.md')}\n*** End Patch`) }, 'node'), 'deny');
  assert.equal(decision('read_memory', { filePath: 'notes.md' }), 'allow');
  assert.equal(decision('read_memory', { filePath: '../outside.md' }), 'deny');
  assert.equal(decision('apply_patch_memory', { input: '*** Begin Patch\n*** Add File: notes.md\n+note\n*** End Patch' }), 'allow');
  assert.equal(decision('apply_patch_memory', { input: '*** Begin Patch\n*** Delete File: ../outside.md\n*** End Patch' }), 'deny');
  for (const value of [null, 'master']) {
    const localPolicy = auth.parseToolAuthorizationPolicyBytes(yaml.dump({ version: 1, ...generate({ reviewer: value }) }));
    assert.equal(auth.evaluateToolAuthorizationPolicy(localPolicy, request('exec', {}, 'node')).action, 'deny');
    assert.equal(auth.evaluateToolAuthorizationPolicy(localPolicy, request('exec', {}, 'node', 'node-a')).action, 'deny');
  }
});

test('copy checks only host legs, including both host paths for master-to-master', () => {
  const own = path.join(config.getAgentDir('reviewer'), 'copy.txt');
  const outside = path.join(scratch, 'outside.txt');
  assert.equal(decision('copy_between_nodes', { sourceNode: 'master', sourcePath: own, targetNode: 'node-a', targetPath: '/remote/target' }), 'allow');
  assert.equal(decision('copy_between_nodes', { sourceNode: 'node-a', sourcePath: '/remote/source', targetNode: 'master', targetPath: own }), 'allow');
  assert.equal(decision('copy_between_nodes', { sourceNode: 'node-a', sourcePath: '/remote/source', targetNode: 'node-a', targetPath: '/remote/target' }), 'allow');
  assert.equal(decision('copy_between_nodes', { sourceNode: 'master', sourcePath: own, targetNode: 'master', targetPath: own }), 'allow');
  assert.equal(decision('copy_between_nodes', { sourceNode: 'master', sourcePath: own, targetNode: 'master', targetPath: outside }), 'deny');
  assert.equal(decision('copy_between_nodes', { sourceNode: 'master', sourcePath: outside, targetNode: 'node-a', targetPath: own }), 'deny');
  assert.equal(decision('copy_between_nodes', { sourceNode: 'node-b', sourcePath: own, targetNode: 'master', targetPath: own }), 'deny');
  const remote = request('read', { filePath: own }, 'node', 'node-a');
  const hostOnly = auth.parseToolAuthorizationPolicyBytes(yaml.dump({ version: 1, defaultAction: 'deny', rules: [{ id: 'host', action: 'allow', match: { path: { allWithin: '${agent.dir}' } } }] }));
  assert.equal(auth.evaluateToolAuthorizationPolicy(hostOnly, remote).action, 'deny');
});

test('Session defaults and canonical relationships retain parent reports but reject siblings and unsafe targets', async () => {
  auth.setToolAuthorizationPolicyForTests(policy);
  await guards.checkToolPermissionForSession(caller, { source: 'builtin', tool: 'send_to_session' }, 'master', { sessionId: '<parent>' });
  await assert.rejects(() => guards.checkToolPermissionForSession(caller, { source: 'builtin', tool: 'send_to_session' }, 'master', { sessionId: 'reviewer/sibling' }), /denies/);
  assert.equal(decision('send_to_session', { sessionId: '<parent>' }), 'allow');
  assert.equal(decision('send_to_session', { sessionId: 'other/child' }), 'allow');
  assert.equal(decision('send_to_session', { sessionId: 'reviewer/sibling' }), 'deny');
  assert.equal(decision('send_to_session', { sessionId: caller.id }), 'deny');
  assert.equal(decision('send_to_session', {}), 'deny');
  assert.equal(decision('send_to_session', { sessionId: 'missing' }), 'deny');
  const file = { filePath: path.join(config.getAgentDir('reviewer'), 'image.png') };
  assert.equal(decision('send_file', file), 'allow');
  assert.equal(decision('send_file', { ...file, sessionId: 'alias' }), 'allow');
  assert.equal(decision('send_file', { ...file, sessionId: 'reviewer/sibling' }), 'deny');
  assert.equal(decision('send_file', { ...file, channelTargetId: 'chat:room' }), 'deny');
  assert.equal(decision('send_file', { filePath: '/remote/image.png' }, 'builtin', 'node-a'), 'allow');
  assert.equal(decision('send_file', { filePath: '/remote/image.png' }, 'builtin', 'node-b'), 'deny');
  assert.equal(decision('session', {}), 'allow');
  assert.equal(decision('session', { action: 'status' }), 'allow');
  assert.equal(decision('session', { sessionId: caller.id }), 'deny');
  assert.equal(decision('session', { action: 'list', scope: 'current-agent' }), 'deny');
  assert.equal(decision('session', { action: 'update-parent', parentSessionId: null }), 'deny');
  assert.equal(decision('get_archived_messages', {}), 'allow');
  assert.equal(decision('get_archived_blocks', { sessionId: 'reviewer/sibling' }), 'allow');
  assert.equal(decision('get_archived_blocks', { sessionId: 'other/child' }), 'deny');
  assert.equal(decision('view_session', { sessionId: caller.id }), 'deny');
  assert.equal(decision('recall', { sessionId: 'reviewer/sibling', target: 'overview' }), 'allow');
  assert.equal(decision('recall', { vector_query: 'context' }), 'deny');
  assert.equal(decision('recall', { vector_query: 'context', scope: 'current-session' }), 'allow');
  assert.equal(decision('recall', { vector_query: 'context', sessionId: 'alias' }), 'allow');
  assert.equal(decision('recall', { vector_query: 'context', sessionId: 'reviewer/sibling' }), 'deny');
  assert.equal(decision('recall', { vector_query: 'context', scope: 'current-session', agentName: 'other' }), 'deny');
});

test('timer create/update choices fence target inheritance and preserve own CRUD', () => {
  assert.equal(decision('create_timer', { afterSeconds: 10 }), 'allow');
  assert.equal(decision('create_timer', { newSession: false }), 'allow');
  assert.equal(decision('create_timer', { newSession: true }), 'allow');
  assert.equal(decision('create_timer', { newSession: true, agentName: 'reviewer', sessionPrefix: 'reminder' }), 'allow');
  assert.equal(decision('create_timer', { newSession: true, agentName: 'other' }), 'deny');
  assert.equal(decision('create_timer', { agentName: 'reviewer' }), 'deny');
  assert.equal(decision('create_timer', { sessionId: 'reviewer/sibling' }), 'deny');
  assert.equal(decision('update_timer', { timerId: 'timer', message: 'updated' }), 'deny');
  assert.equal(decision('update_timer', { timerId: 'timer', newSession: false }), 'allow');
  assert.equal(decision('update_timer', { timerId: 'timer', newSession: false, sessionPrefix: 'old' }), 'deny');
  assert.equal(decision('update_timer', { timerId: 'timer', newSession: true }), 'deny');
  assert.equal(decision('update_timer', { timerId: 'timer', newSession: true, agentName: 'reviewer' }), 'allow');
  for (const name of ['list_timers', 'delete_timer']) {
    assert.equal(decision(name, {}), 'allow');
    assert.equal(decision(name, { sessionId: 'reviewer/sibling' }), 'deny');
  }
});

test('allowlist preserves other callers and skill discovery while leaving management/container tools denied', async () => {
  assert.equal(decision('skill', { action: 'list' }), 'allow');
  assert.equal(decision('skill', { action: 'load', agentName: 'reviewer' }), 'allow');
  assert.equal(decision('skill', { action: 'load', agentName: 'other' }), 'deny');
  for (const name of ['task', 'run_script', 'create_child_session', 'set_config', 'send_to_channel']) {
    assert.equal(decision(name, {}), 'deny');
  }
  assert.equal(decision('search_tools', {}), 'allow');
  const other = { id: 'unlisted/main', agent: 'unlisted' };
  assert.equal(decision('exec', {}, 'node', 'master', other), 'allow');
  const combined = auth.parseToolAuthorizationPolicyBytes(yaml.dump({ version: 1, defaultAction: 'allow', rules: [{ id: 'existing-other-deny', match: { agent: 'unlisted' }, action: 'deny' }, ...generate({ reviewer: 'node-a' }).rules] }));
  assert.equal(auth.evaluateToolAuthorizationPolicy(combined, request('exec', {}, 'node', 'master', other)).action, 'deny');
  const loaded = await skills.loadSkillDocuments('access-control', { agentName: 'reviewer' });
  assert.ok(loaded.info.resourceFiles.includes('scripts/generate-isolated-rules.mjs'));
  assert.ok(loaded.info.resourceFiles.includes('references/isolated-rules.md'));
});
