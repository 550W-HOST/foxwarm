import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMcpInboundConfig, authenticateMcpInboundBearer } from './mcpInboundConfig';
import type { ExternalExecutionContext } from './mcpInboundHttp';
import { callExternalNodeTool, externalExecResult, ExternalNodeBeforeEffectError, releaseExternalNodeContext } from './mcpInboundNodeService';
import { nodesManager } from './nodes/manager';
import { AuthenticatedRemoteNodeProvider } from './nodes/providerRegistry';
import { nodeProviderRegistry } from './nodes/providers';
import {
  completeExternalExec, getExternalExec, listExternalExec, reserveExternalExec, resetExternalExecOwnershipForTests,
} from './nodes/externalExecOwnership';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';

const nodeId = 'synthetic-external-owner-node';
const credentials = normalizeMcpInboundConfig({ enabled: true, identities: { alpha: { token: 'synthetic-owner-token' } } });
const principal = authenticateMcpInboundBearer(credentials, 'Bearer synthetic-owner-token')!;
const policy = parseToolAuthorizationPolicyBytes(`version: 1
rules:
  - id: synthetic-owner-exec
    match: { externalId: alpha, tool: { source: node, name: [exec, write] }, targetNode: synthetic-external-owner-node }
    action: allow
`);
const descriptor = { id: nodeId, kind: 'remote', provider: 'authenticated-remote', type: 'cli-node',
  availability: 'ready', tools: [{ name: 'exec' }, { name: 'write' }, { name: 'get_default_cwd' }] };

function newContext(): ExternalExecutionContext {
  return { id: '44444444-4444-4444-8444-555555555555', externalId: 'alpha', currentNode: nodeId,
    cwd: '/tmp', selectionGeneration: 1, disposed: false };
}
function identity(context: ExternalExecutionContext) {
  return { kind: 'external' as const, externalId: 'alpha', contextId: context.id };
}
function fakeAuthenticatedNode(complete?: (call: { args: { command: string } }) => string) {
  const packets: Array<{ type: string; callId?: string; backgroundExecId?: string }> = [];
  const nodes = (nodesManager as any).nodes as Map<string, unknown>;
  assert.equal(nodes.has(nodeId), false);
  nodes.set(nodeId, {
    id: nodeId, protocolCompatibility: { status: 'compatible', negotiated: 3 },
    capabilities: { features: { externalToolOwner: 1 } }, tools: new Set(['exec', 'write', 'get_default_cwd']),
    ws: { send(raw: string) {
      const packet = JSON.parse(raw);
      packets.push(packet);
      // A broken fence must fail as a sent effect instead of hanging this test for 62 seconds.
      if (packet.type === 'tool_call') queueMicrotask(() => complete
        ? nodesManager.handleToolResponse(packet.callId, { execId: packet.backgroundExecId,
          background: false, output: complete(packet) }, nodeId)
        : nodesManager.handleToolError(packet.callId,
          { message: 'Unexpected synthetic Node tool dispatch.' }, false, nodeId));
    } },
  });
  return { packets, cleanup: () => nodes.delete(nodeId) };
}

for (const gateAt of [1, 2]) {
  test(`external context release fences an exec at ${gateAt === 1 ? 'capability resolution' : 'post-reservation dispatch resolution'}`, async () => {
    resetExternalExecOwnershipForTests();
    setToolAuthorizationPolicyForTests(policy);
    const context = newContext();
    const node = fakeAuthenticatedNode();
    const originalResolve = nodeProviderRegistry.resolveNode;
    let opened!: () => void;
    const entered = new Promise<void>(resolve => { opened = resolve; });
    let proceed!: () => void;
    const gate = new Promise<void>(resolve => { proceed = resolve; });
    let calls = 0;
    (nodeProviderRegistry as any).resolveNode = async () => {
      if (++calls === gateAt) { opened(); await gate; }
      return { descriptor, provider: new AuthenticatedRemoteNodeProvider() };
    };
    let pending: Promise<unknown> | undefined;
    try {
      pending = callExternalNodeTool(principal, context, nodeId, 'exec', { command: 'printf never-run' });
      await Promise.race([entered, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Node resolution gate not reached')), 5_000))]);
      const reserved = listExternalExec(identity(context), 20);
      assert.equal(reserved.length, gateAt === 1 ? 0 : 1);
      releaseExternalNodeContext(principal, context);
      assert.equal(context.disposed, true);
      assert.deepEqual(node.packets.map(packet => packet.type), gateAt === 1 ? [] : ['external_exec_release']);
      assert.deepEqual(listExternalExec(identity(context), 20), []);
      if (reserved.length) {
        const record = reserved[0];
        assert.equal(completeExternalExec(nodeId, identity(context), record.execId, record.capability, 'late'), false);
      }
      proceed();
      await assert.rejects(pending, error => error instanceof ExternalNodeBeforeEffectError);
      assert.deepEqual(listExternalExec(identity(context), 20), [], 'no late reservation after release');
      assert.equal(node.packets.some(packet => packet.type === 'tool_call'), false, 'no tool sent after context release');
    } finally {
      proceed();
      await pending?.catch(() => {});
      (nodeProviderRegistry as any).resolveNode = originalResolve;
      node.cleanup();
      resetExternalExecOwnershipForTests();
      setToolAuthorizationPolicyForTests(undefined);
    }
  });
}

test('a non-exec Node write cannot cross the disposed context after provider resolution', async () => {
  resetExternalExecOwnershipForTests();
  setToolAuthorizationPolicyForTests(policy);
  const context = newContext();
  const node = fakeAuthenticatedNode();
  const originalResolve = nodeProviderRegistry.resolveNode;
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  let proceed!: () => void;
  const gate = new Promise<void>(resolve => { proceed = resolve; });
  let calls = 0;
  (nodeProviderRegistry as any).resolveNode = async () => {
    if (++calls === 2) { entered(); await gate; }
    return { descriptor, provider: new AuthenticatedRemoteNodeProvider() };
  };
  let pending: Promise<unknown> | undefined;
  try {
    pending = callExternalNodeTool(principal, context, nodeId, 'write', { filePath: '/tmp/not-written', content: 'none' });
    await Promise.race([reached, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Node write gate not reached')), 5_000))]);
    releaseExternalNodeContext(principal, context);
    proceed();
    await assert.rejects(pending, error => error instanceof ExternalNodeBeforeEffectError);
    assert.deepEqual(node.packets, []);
  } finally {
    proceed();
    await pending?.catch(() => {});
    (nodeProviderRegistry as any).resolveNode = originalResolve;
    node.cleanup();
    resetExternalExecOwnershipForTests();
    setToolAuthorizationPolicyForTests(undefined);
  }
});

test('twenty retained completed results admit the twenty-first and later real dispatches, evicting only completed records', async () => {
  resetExternalExecOwnershipForTests();
  setToolAuthorizationPolicyForTests(policy);
  const context = newContext();
  const owner = identity(context);
  const node = fakeAuthenticatedNode(call => `result ${call.args.command.slice('printf '.length)}`);
  const originalResolve = nodeProviderRegistry.resolveNode;
  (nodeProviderRegistry as any).resolveNode = async () => ({ descriptor, provider: new AuthenticatedRemoteNodeProvider() });
  try {
    const ids: string[] = [];
    for (let index = 0; index < 22; index++) {
      const result = await callExternalNodeTool(principal, context, nodeId, 'exec', { command: `printf ${index}` }) as any;
      ids.push(result.execId);
      assert.equal(result.output, `result ${index}`);
      assert.ok(listExternalExec(owner, 20).length <= 20);
    }
    assert.equal(node.packets.filter(packet => packet.type === 'tool_call').length, 22);
    assert.equal(getExternalExec(owner, ids[0]), undefined);
    assert.equal(getExternalExec(owner, ids[1]), undefined);
    assert.equal(getExternalExec(owner, ids[2])?.output, 'result 2');
    assert.equal(getExternalExec(owner, ids[21])?.output, 'result 21');
    assert.equal((await externalExecResult(principal, context, ids[21]) as any).output, 'result 21');
    await assert.rejects(() => externalExecResult(principal, context, ids[0]), /unavailable/);
    assert.equal(listExternalExec(owner, 20).length, 20);
    releaseExternalNodeContext(principal, context);
    assert.equal(node.packets.filter(packet => packet.type === 'external_exec_release').length, 1);
    assert.equal(context.externalExecNodes?.size, 0);
  } finally {
    releaseExternalNodeContext(principal, context);
    (nodeProviderRegistry as any).resolveNode = originalResolve;
    node.cleanup();
    resetExternalExecOwnershipForTests();
    setToolAuthorizationPolicyForTests(undefined);
  }
});

test('twenty unresolved exec reservations reject a new effect without evicting ownership', async () => {
  resetExternalExecOwnershipForTests();
  setToolAuthorizationPolicyForTests(policy);
  const context = newContext();
  const owner = identity(context);
  const node = fakeAuthenticatedNode();
  const originalResolve = nodeProviderRegistry.resolveNode;
  (nodeProviderRegistry as any).resolveNode = async () => ({ descriptor, provider: new AuthenticatedRemoteNodeProvider() });
  try {
    const ids: string[] = [];
    for (let index = 0; index < 20; index++) ids.push(reserveExternalExec(owner, nodeId, { command: `sleep ${index + 1}` }).execId);
    await assert.rejects(() => callExternalNodeTool(principal, context, nodeId, 'exec', { command: 'printf blocked' }),
      error => error instanceof ExternalNodeBeforeEffectError);
    assert.equal(listExternalExec(owner, 20).length, 20);
    assert.ok(ids.every(id => !!getExternalExec(owner, id)));
    assert.equal(node.packets.some(packet => packet.type === 'tool_call'), false);
  } finally {
    releaseExternalNodeContext(principal, context);
    (nodeProviderRegistry as any).resolveNode = originalResolve;
    node.cleanup();
    resetExternalExecOwnershipForTests();
    setToolAuthorizationPolicyForTests(undefined);
  }
});
