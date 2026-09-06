import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  buildToolAuthorizationRequest,
  evaluateToolAuthorization,
  evaluateToolAuthorizationSync,
  installToolAuthorizationPolicyBytes,
  isToolAuthorizationPolicyUnavailable,
  loadToolAuthorizationPolicy,
  loadToolAuthorizationPolicySync,
  parseToolAuthorizationPolicyBytes,
  setToolAuthorizationPolicyForTests,
  setToolAuthorizationPolicyPathForTests,
  setToolAuthorizationTestClockForTests,
  type ToolAuthorizationPolicy,
} from './toolAuthorization';
import { checkToolPermissionForSession, isToolVisibleForSession } from './isolatedCheck';
import { tool_set_tool_rules } from './tools/toolAuthorizationTools';
import { executeTools } from './llm';
import * as tools from './tools';
import { tool_run_script } from './toolscript';
import { canonicalPotentialPathSync } from './utils/pathResolve';
import { getAgentDir } from './config';

const allowPolicy = (): ToolAuthorizationPolicy => ({ version: 1, defaultAction: 'allow', rules: [] });

function reset(): void {
  setToolAuthorizationPolicyForTests(undefined);
  setToolAuthorizationPolicyPathForTests(undefined);
  setToolAuthorizationTestClockForTests(undefined, undefined);
}

test.afterEach(reset);

test('strict policy parser accepts ordered rules and rejects unknown or unsafe shapes', () => {
  const parsed = parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: deny
rules:
  - id: allow-read
    match:
      agent: worker
      tool: { source: node, name: [read, exec] }
      targetNode: node-a
      args:
        action: { oneOf: [inspect, list] }
      path: { arg: filePath, allWithin: "${'${agent.dir}'}" }
    action: allow
`);
  assert.equal(parsed.defaultAction, 'deny');
  assert.equal(parsed.rules[0].id, 'allow-read');
  assert.throws(() => parseToolAuthorizationPolicyBytes('version: 2\ndefaultAction: allow\nrules: []\n'), /version must be 1/i);
  assert.throws(() => parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nextra: true\nrules: []\n'), /unsupported field/i);
  assert.throws(() => parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: x\n  match:\n    args:\n      __proto__.x: true\n  action: deny\n'), /unsafe dotted path/i);
  assert.throws(() => parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: x\n  match: { agent: { regex: x } }\n  action: deny\n'), /unsupported field/i);
  assert.throws(() => parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: x\n  match: { tool: { source: provider, name: read } }\n  action: deny\n'), /source values must be builtin, mcp, or node/i);
  assert.throws(() => parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: x\n  match: { path: { allWithin: "${unknown}" } }\n  action: deny\n'), /unsupported path variable/i);
});

test('evaluator uses first match, source/server/target selectors, args, and master path containment', async () => {
  const agentDir = path.join(os.tmpdir(), `tool-auth-agent-${Date.now()}`);
  const policy = parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: deny
rules:
  - id: first-deny
    match: { agent: demo, tool: { source: node, name: exec }, targetNode: master }
    action: deny
  - id: later-allow
    match: { agent: demo, tool: exec }
    action: allow
  - id: allow-mcp
    match: { tool: { source: mcp, server: docs, name: search }, args: { limit: { equals: 5 } } }
    action: allow
  - id: allow-path
    match: { tool: { source: node, name: read }, targetNode: master, path: { arg: filePath, allWithin: "${agentDir}" } }
    action: allow
`);
  setToolAuthorizationPolicyForTests(policy);
  const exec = await evaluateToolAuthorization(buildToolAuthorizationRequest({
    session: { id: 'demo/main', agent: 'demo', cwd: agentDir }, tool: { source: 'node', name: 'exec' }, targetNode: 'master', args: {},
  }));
  assert.equal(exec.rule?.id, 'first-deny');
  const mcp = await evaluateToolAuthorization(buildToolAuthorizationRequest({
    session: { id: 'demo/main', agent: 'demo' }, tool: { source: 'mcp', server: 'docs', name: 'search' }, args: { limit: 5 },
  }));
  assert.equal(mcp.action, 'allow');
  const inside = await evaluateToolAuthorization(buildToolAuthorizationRequest({
    session: { id: 'demo/main', agent: 'demo', cwd: agentDir }, tool: { source: 'node', name: 'read' }, targetNode: 'master', args: { filePath: path.join(agentDir, 'a.txt') },
  }));
  assert.equal(inside.rule?.id, 'allow-path');
  const remote = await evaluateToolAuthorization(buildToolAuthorizationRequest({
    session: { id: 'demo/main', agent: 'demo' }, tool: { source: 'node', name: 'read' }, targetNode: 'remote', args: { filePath: '/same/text' },
  }));
  assert.equal(remote.action, 'deny');
});


test('visibility preserves ordered definite decisions and keeps conditional possible allows discoverable', () => {
  const session: any = { id: 'plain/main', agent: 'plain', currentNode: 'master' };
  const visible = (policy: string) => {
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(policy));
    return isToolVisibleForSession(session, { source: 'builtin', tool: 'node' }, 'master');
  };
  assert.equal(visible(`
version: 1
defaultAction: deny
rules:
- id: allow-inspect
  match: { tool: { source: builtin, name: node }, args: { action: inspect } }
  action: allow
`), true);
  assert.equal(visible(`
version: 1
defaultAction: deny
rules:
- id: deny-destroy
  match: { tool: node, args: { action: destroy } }
  action: deny
- id: allow-inspect
  match: { tool: node, args: { action: inspect } }
  action: allow
`), true);
  assert.equal(visible(`
version: 1
defaultAction: deny
rules:
- id: deny-destroy
  match: { tool: node, args: { action: destroy } }
  action: deny
`), false);
  assert.equal(visible(`
version: 1
defaultAction: allow
rules:
- id: deny-node
  match: { tool: { source: builtin, name: node } }
  action: deny
- id: allow-inspect
  match: { tool: node, args: { action: inspect } }
  action: allow
`), false);
  assert.equal(visible(`
version: 1
defaultAction: deny
rules:
- id: allow-node
  match: { tool: node }
  action: allow
- id: deny-destroy
  match: { tool: node, args: { action: destroy } }
  action: deny
`), true);
});

test('path facts canonicalize symlink prefixes, nonexistent children, policy bases, copy legs, and sources', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-canonical-'));
  const allowed = path.join(dir, 'allowed');
  const outside = path.join(dir, 'outside');
  await fs.ensureDir(allowed); await fs.ensureDir(outside);
  await fs.writeFile(path.join(outside, 'existing.txt'), 'outside');
  await fs.symlink(outside, path.join(allowed, 'link'), 'dir');
  const session: any = { id: 'plain/main', agent: 'plain', currentNode: 'master', cwd: allowed };
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: deny
rules:
- id: allow-contained-node-files
  match: { tool: { source: node, name: [read, write] }, path: { arg: filePath, allWithin: "${allowed}" } }
  action: allow
`));
  await assert.rejects(() => tools.callTool('read', { filePath: 'link/existing.txt' }, { sessionId: session.id, session } as any), /denies node capability/i);
  await assert.rejects(() => tools.callTool('write', { filePath: 'link/new/child.txt', content: 'blocked', createDirs: true }, { sessionId: session.id, session } as any), /denies node capability/i);
  assert.equal(await fs.pathExists(path.join(outside, 'new', 'child.txt')), false);
  const danglingTarget = path.join(outside, 'dangling-created.txt');
  await fs.symlink(danglingTarget, path.join(allowed, 'dangling.txt'));
  await assert.rejects(() => tools.callTool('write', { filePath: 'dangling.txt', content: 'blocked' }, { sessionId: session.id, session } as any), /denies node capability/i);
  assert.equal(await fs.pathExists(danglingTarget), false);

  const baseLink = path.join(dir, 'base-link'); await fs.symlink(outside, baseLink, 'dir');
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: deny
rules:
- id: allow-canonical-base
  match: { tool: read, path: { allWithin: "${baseLink}" } }
  action: allow
`));
  assert.equal((await evaluateToolAuthorization(buildToolAuthorizationRequest({
    session, tool: { source: 'node', name: 'read' }, targetNode: 'master', args: { filePath: path.join(outside, 'existing.txt') },
  }))).action, 'allow');

  const copy = buildToolAuthorizationRequest({
    session: { ...session, cwd: outside }, tool: { source: 'builtin', name: 'copy_between_nodes' }, targetNode: 'master',
    args: { sourceNode: 'master', sourcePath: 'source.txt', targetNode: 'master', targetPath: 'nested/target.txt' },
  });
  assert.equal(copy.paths[0].resolved, canonicalPotentialPathSync(path.join(getAgentDir('plain'), 'source.txt')));
  assert.equal(copy.paths[1].resolved, canonicalPotentialPathSync(path.join(getAgentDir('plain'), 'nested/target.txt')));
  const mcpRead = buildToolAuthorizationRequest({ session, tool: { source: 'mcp', server: 'files', name: 'read' }, targetNode: 'master', args: { filePath: 'link/existing.txt' } });
  assert.deepEqual(mcpRead.paths, []);
  const patch = buildToolAuthorizationRequest({
    session, tool: { source: 'node', name: 'apply_patch' }, targetNode: 'master', args: { input: [
      '*** Begin Patch',
      '*** Add File: added.txt', '+added',
      '*** Update File: existing.txt', '@@', '-outside', '+updated',
      '*** Delete File: deleted.txt',
      '*** End Patch',
    ].join('\n') },
  });
  assert.deepEqual(patch.paths.map(record => record.raw), ['added.txt', 'existing.txt', 'deleted.txt']);
  await fs.remove(dir);
});

test('successful policies cache for ten seconds and async stale failures retry after 100ms', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-cache-'));
  const file = path.join(dir, 'rules.yaml');
  await fs.writeFile(file, 'version: 1\ndefaultAction: allow\nrules: []\n');
  let now = 1000;
  const delays: number[] = [];
  setToolAuthorizationPolicyPathForTests(file);
  setToolAuthorizationTestClockForTests(() => now, async ms => { delays.push(ms); });
  assert.equal((await loadToolAuthorizationPolicy()).defaultAction, 'allow');
  await fs.writeFile(file, 'version: 1\ndefaultAction: deny\nrules: []\n');
  now += 9999;
  assert.equal((await loadToolAuthorizationPolicy()).defaultAction, 'allow');
  now += 1;
  assert.equal((await loadToolAuthorizationPolicy()).defaultAction, 'deny');
  now += 10000;
  await fs.writeFile(file, 'not: valid: yaml:');
  await assert.rejects(() => loadToolAuthorizationPolicy(), error => isToolAuthorizationPolicyUnavailable(error));
  assert.deepEqual(delays, [100]);
  await fs.remove(dir);
});

test('sync loader retries immediately and only ENOENT is compatibility allow', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-sync-'));
  const missing = path.join(dir, 'missing.yaml');
  setToolAuthorizationPolicyPathForTests(missing);
  assert.equal(loadToolAuthorizationPolicySync().defaultAction, 'allow');
  let now = 0;
  setToolAuthorizationTestClockForTests(() => now);
  await fs.writeFile(missing, 'broken: [');
  now = 10000;
  assert.throws(() => loadToolAuthorizationPolicySync(), error => isToolAuthorizationPolicyUnavailable(error));
  await fs.remove(dir);
});

test('generic deny applies to non-isolated sessions before isolated compatibility checks', async () => {
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: allow
rules:
- id: deny-exec
  match: { agent: plain, tool: { source: node, name: exec }, targetNode: master }
  action: deny
`));
  const session: any = { id: 'plain/main', agent: 'plain', currentNode: 'master' };
  await assert.rejects(() => checkToolPermissionForSession(session, { source: 'node', node: 'master', tool: 'exec' }, 'master', { command: 'true' }), /denies node capability/i);
  await assert.doesNotReject(() => checkToolPermissionForSession(session, { source: 'builtin', tool: 'wait' }, 'master', { waitForInput: true }));
  assert.equal(evaluateToolAuthorizationSync(buildToolAuthorizationRequest({ session, tool: { source: 'builtin', name: 'wait' } })).action, 'allow');
});

test('direct and unified Node calls share the same generic resolved identity', async () => {
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: allow
rules:
- id: deny-master-exec
  match: { agent: plain, tool: { source: node, name: exec }, targetNode: master }
  action: deny
`));
  const session: any = { id: 'plain/main', agent: 'plain', currentNode: 'master' };
  const ctx: any = { sessionId: session.id, session };
  await assert.rejects(() => tools.callTool('exec', { command: 'true' }, ctx), /denies node capability/i);
  await assert.rejects(() => tools.call_tool({ source: 'node', nodeId: 'master', name: 'exec', args: { command: 'true' } }, ctx), /denies node capability/i);
});

test('set_tool_rules uses the current policy, validates captured bytes, and leaves destination unchanged on invalid candidate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-setter-'));
  const active = path.join(dir, 'active.yaml');
  const candidate = path.join(dir, 'candidate.yaml');
  const original = Buffer.from('version: 1\ndefaultAction: allow\nrules: []\n');
  await fs.writeFile(active, original);
  await fs.writeFile(candidate, 'version: 1\ndefaultAction: deny\nrules: []\n');
  setToolAuthorizationPolicyPathForTests(active);
  setToolAuthorizationPolicyForTests(allowPolicy());
  const session: any = { id: 'plain/main', agent: 'plain', currentNode: 'master', cwd: dir };
  await tool_set_tool_rules({ filePath: candidate }, { sessionId: session.id, session } as any);
  assert.equal(parseToolAuthorizationPolicyBytes(await fs.readFile(active)).defaultAction, 'deny');

  setToolAuthorizationPolicyForTests(allowPolicy());
  await fs.writeFile(candidate, 'broken: [');
  const before = await fs.readFile(active);
  await assert.rejects(() => tool_set_tool_rules({ filePath: candidate }, { sessionId: session.id, session } as any), /YAML|flow collection|unexpected/i);
  assert.deepEqual(await fs.readFile(active), before);

  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: allow
rules:
- id: deny-setter
  match: { tool: { source: builtin, name: set_tool_rules } }
  action: deny
`));
  await assert.rejects(() => tool_set_tool_rules({ filePath: candidate }, { sessionId: session.id, session } as any), /denies builtin capability/i);

  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: allow
rules:
- id: allow-setter
  match: { tool: { source: builtin, name: set_tool_rules } }
  action: allow
- id: deny-candidate-read
  match: { tool: { source: node, name: read }, targetNode: master }
  action: deny
`));
  await assert.rejects(() => tool_set_tool_rules({ filePath: candidate }, { sessionId: session.id, session } as any), /denies node capability/i);

  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-setter-outside-'));
  const outsideCandidate = path.join(outsideDir, 'candidate.yaml');
  const candidateLink = path.join(dir, 'candidate-link.yaml');
  await fs.writeFile(outsideCandidate, 'version: 1\ndefaultAction: allow\nrules: []\n');
  await fs.symlink(outsideCandidate, candidateLink);
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: deny
rules:
- id: allow-setter
  match: { tool: { source: builtin, name: set_tool_rules } }
  action: allow
- id: allow-contained-read
  match: { tool: { source: node, name: read }, path: { allWithin: "${dir}" } }
  action: allow
`));
  await assert.rejects(() => tool_set_tool_rules({ filePath: candidateLink }, { sessionId: session.id, session } as any), /denies node capability/i);
  await fs.remove(outsideDir);
  await fs.remove(dir);
});

test('atomic installer writes the exact validated bytes and rejects invalid content before replacement', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-install-'));
  const active = path.join(dir, 'rules.yaml');
  setToolAuthorizationPolicyPathForTests(active);
  const exact = Buffer.from('version: 1\ndefaultAction: deny\nrules: []\n# exact bytes\n');
  await installToolAuthorizationPolicyBytes(exact);
  assert.deepEqual(await fs.readFile(active), exact);
  await assert.rejects(() => installToolAuthorizationPolicyBytes(Buffer.from('broken: [')));
  assert.deepEqual(await fs.readFile(active), exact);
  await fs.remove(dir);
});

test('policy unavailability preserves paired tool responses and requests a fatal current-turn stop', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-fatal-'));
  const active = path.join(dir, 'rules.yaml');
  await fs.writeFile(active, 'broken: [');
  setToolAuthorizationPolicyPathForTests(active);
  setToolAuthorizationTestClockForTests(() => 10000, async () => {});
  const session: any = { id: 'plain/main', agent: 'plain', currentNode: 'master', history: [], queue: [] };
  let starts = 0;
  const message: any = await executeTools([
    { id: 'fatal-call', name: 'wait', args: { waitForInput: true } },
    { id: 'skipped-call', name: 'set_goal', args: { goal: 'must not run' } },
  ], { sessionId: session.id, session, onToolStart: () => { starts += 1; } }, session, {
    currentSessionEffects: {
      placement: 'local',
      persistSession: async () => {},
      appendMessage: async () => {},
      appendMessages: async () => {},
      notifyHistoryUpdate: () => {},
      notifySessionEvent: () => {},
      setRuntimeState: () => {},
      clearRuntimeState: () => {},
      startWait: async () => ({ id: 'unused' }),
      clearWaitById: async () => {},
    } as any,
  });
  assert.equal(starts, 0);
  const responses = message.parts.filter((part: any) => part.functionResponse);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].functionResponse.tool_use_id, 'fatal-call');
  assert.equal(responses[0].functionResponse.response.code, 'TOOL_AUTH_POLICY_UNAVAILABLE');
  assert.equal(responses[1].functionResponse.tool_use_id, 'skipped-call');
  assert.match(responses[1].functionResponse.response.error, /authorization policy was unavailable/i);
  assert.equal(message.__toolLoopControl.stopCurrentTurn, true);
  assert.equal(message.__toolLoopControl.fatalError.code, 'TOOL_AUTH_POLICY_UNAVAILABLE');
  await fs.remove(dir);
});


test('foreground ToolScript propagates policy unavailability while background mode only fails its run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-auth-script-fatal-'));
  const active = path.join(dir, 'rules.yaml');
  await fs.writeFile(active, 'broken: [');
  setToolAuthorizationPolicyPathForTests(active);
  setToolAuthorizationTestClockForTests(() => 10000, async () => {});
  const session: any = { id: `plain/script-${Date.now()}`, agent: 'plain', currentNode: 'master', history: [], queue: [] };
  const ctx: any = { sessionId: session.id, session };
  const code = 'def main(args):\n    return call_tool("wait", {"waitForInput": True})';
  await assert.rejects(() => tool_run_script({ code, mode: 'foreground' }, ctx), error => isToolAuthorizationPolicyUnavailable(error));
  const background = await tool_run_script({ code, mode: 'background' }, ctx);
  assert.equal(background.status, 'failed');
  assert.match(String(background.error), /authorization policy is unavailable/i);
  await fs.remove(dir);
});
