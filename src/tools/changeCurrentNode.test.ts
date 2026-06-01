import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import { getAgentDir } from '../config';
import { nodesManager } from '../nodes/manager';
import { change_current_node } from '../tools';

test('change_current_node clears session cwd and reports master default cwd', async () => {
  const originalGetSession = sessionManager.getSession;
  const originalSaveSession = sessionManager.saveSession;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalSetCurrentNode = nodesManager.setCurrentNode;
  const session: any = { id: 'test-session', agent: 'main', currentNode: 'old-node', cwd: '/tmp/old-cwd' };
  let saved = false;

  try {
    (sessionManager as any).getSession = async () => session;
    (sessionManager as any).saveSession = async () => { saved = true; };
    (sessionManager as any).isSessionEffectivelyIsolated = () => false;
    (nodesManager as any).setCurrentNode = () => {};

    const result = await change_current_node({ nodeId: 'master' }, { sessionId: 'test-session', session } as any);

    assert.equal(session.currentNode, 'master');
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'cwd'), false);
    assert.equal(saved, true);
    assert.match(String(result), /Session cwd cleared/);
    assert.match(String(result), new RegExp(getAgentDir('main').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    (sessionManager as any).getSession = originalGetSession;
    (sessionManager as any).saveSession = originalSaveSession;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (nodesManager as any).setCurrentNode = originalSetCurrentNode;
  }
});

test('change_current_node reports remote default cwd through lightweight node tool when available', async () => {
  const originalGetSession = sessionManager.getSession;
  const originalSaveSession = sessionManager.saveSession;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalSetCurrentNode = nodesManager.setCurrentNode;
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  const session: any = { id: 'test-session', agent: 'main', currentNode: 'master', cwd: '/tmp/old-cwd' };
  let executedTool: { nodeId: string; tool: string } | null = null;

  try {
    (sessionManager as any).getSession = async () => session;
    (sessionManager as any).saveSession = async () => {};
    (sessionManager as any).isSessionEffectivelyIsolated = () => false;
    (nodesManager as any).setCurrentNode = () => {};
    (nodesManager as any).getNode = () => ({ id: 'remote-test', tools: new Set(['get_default_cwd']) });
    (nodesManager as any).executeTool = async (nodeId: string, tool: string) => {
      executedTool = { nodeId, tool };
      return '/remote/default-cwd';
    };

    const result = await change_current_node({ nodeId: 'remote-test' }, { sessionId: 'test-session', session } as any);

    assert.deepEqual(executedTool, { nodeId: 'remote-test', tool: 'get_default_cwd' });
    assert.equal(session.currentNode, 'remote-test');
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'cwd'), false);
    assert.match(String(result), /\/remote\/default-cwd/);
  } finally {
    (sessionManager as any).getSession = originalGetSession;
    (sessionManager as any).saveSession = originalSaveSession;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (nodesManager as any).setCurrentNode = originalSetCurrentNode;
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
  }
});
