import '../testEnvironment';
import '../sessionManager';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthenticatedRemoteNodeProvider } from './providerRegistry';
import { nodesManager } from './manager';
import { applyExactReplacement } from '../../packages/shared/dist/exactReplacement';

// Exercise the maintained resident adapter against the legacy JS edit implementation.
test('resident adapter preserves literals, one-write batches, original matching, and native negotiation', async () => {
  const original = { getNode: nodesManager.getNode, executeTool: nodesManager.executeTool, executeExternalTool: nodesManager.executeExternalTool };
  const peer: any = { id: 'edit-peer', type: 'cli-node', ws: {}, tools: new Set(['read', 'edit', 'apply_patch']), capabilities: { features: { programmaticToolData: true } } };
  const provider = new AuthenticatedRemoteNodeProvider();
  const calls: Array<{ name: string; args: any }> = [];
  let content = 'first second\r\n';
  let denyRead = false;
  const execute = async (_node: string, name: string, args: any) => {
    calls.push({ name, args });
    if (name === 'read') {
      if (denyRead) throw new Error('Read rejected by operator');
      const source = content;
      return { content: source, sizeBytes: Buffer.byteLength(source), selectedBytes: Buffer.byteLength(source), truncated: false };
    }
    if (name === 'edit' && !peer.capabilities.features.unifiedEdit) content = applyExactReplacement(content, args.oldText, args.newText, 'oldText');
    return { output: 'edited' };
  };
  (nodesManager as any).getNode = () => peer;
  (nodesManager as any).executeTool = execute;
  (nodesManager as any).executeExternalTool = execute;
  const session = { sourceSessionId: 'missing-test-session', nodeId: peer.id, toolName: 'edit', context: { agent: 'main', currentNode: peer.id, cwd: '/project' } };
  const batch = { filePath: 'file', edits: [{ oldText: 'first', newText: 'second' }, { oldText: 'second', newText: '$$-$&-$`-$\'\n' }] };
  try {
    await provider.invokeTool({ ...session, args: batch });
    assert.deepEqual(calls.map(call => call.name), ['read', 'edit']);
    assert.equal(content, 'second $$-$&-$`-$\'\n\r\n');
    assert.equal(calls[1].args.oldText, 'first second\r\n');
    calls.length = 0;
    await provider.invokeTool({ ...session, args: { filePath: 'file', oldText: 'second', newText: '$&\n', replaceAll: false } });
    assert.deepEqual(calls.map(call => call.name), ['edit']);
    assert.equal(content, '$&\n $$-$&-$`-$\'\n\r\n');
    calls.length = 0;
    content = 'first second';
    denyRead = true;
    await assert.rejects(() => provider.invokeTool({ ...session, args: batch }), /rejected by operator/);
    assert.deepEqual(calls.map(call => call.name), ['read']);
    calls.length = 0;
    denyRead = false;
    await assert.rejects(() => provider.invokeTool({ ...session, args: { ...batch, edits: [{ oldText: 'absent', newText: '' }] } }), /Could not find/);
    assert.deepEqual(calls.map(call => call.name), ['read']);
    calls.length = 0;
    // Whole-file legacy matching rejects source removal/replacement rather than applying sequential edits.
    const savedExecute = (nodesManager as any).executeTool;
    (nodesManager as any).executeTool = async (...args: any[]) => {
      if (args[1] === 'edit') content = 'concurrent replacement';
      return savedExecute(...args);
    };
    await assert.rejects(() => provider.invokeTool({ ...session, args: batch }), /Could not find/);
    assert.equal(content, 'concurrent replacement');
    content = 'first second';
    (nodesManager as any).executeTool = async (...args: any[]) => {
      if (args[1] === 'edit') content = 'prefix ' + content + ' suffix';
      return savedExecute(...args);
    };
    await provider.invokeTool({ ...session, args: batch });
    assert.equal(content, 'prefix second $$-$&-$`-$\'\n suffix');
    (nodesManager as any).executeTool = savedExecute;
    calls.length = 0;
    const patch = '*** Begin Patch\n*** Delete File: file\n*** End Patch';
    await provider.invokeTool({ ...session, args: { apply_patch: patch } });
    assert.deepEqual(calls, [{ name: 'apply_patch', args: { input: patch } }]);
    calls.length = 0;
    const external = { owner: { kind: 'external' as const, externalId: 'alpha', contextId: 'context' }, nodeId: peer.id, toolName: 'edit', context: {} };
    for (const args of [batch, { filePath: 'file', oldText: 'a', newText: 'b', replaceAll: true }]) await assert.rejects(() => provider.invokeTool({ ...external, args }), /Upgrade/);
    assert.equal(calls.length, 0);
    content = 'first second';
    await provider.invokeTool({ ...external, args: { filePath: 'file', oldText: 'first', newText: '$&', replaceAll: false } });
    assert.equal(content, '$& second');
    await provider.invokeTool({ ...external, args: { apply_patch: patch } });
    assert.equal(calls[1].name, 'apply_patch');
    calls.length = 0;
    peer.capabilities.features.unifiedEdit = true;
    await provider.invokeTool({ ...session, args: batch });
    await provider.invokeTool({ ...external, args: batch });
    assert.deepEqual(calls, [{ name: 'edit', args: batch }, { name: 'edit', args: batch }]);
  } finally { Object.assign(nodesManager, original); }
});
