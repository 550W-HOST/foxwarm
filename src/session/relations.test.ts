import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermittedSessionTarget, setSessionParent } from './relations';
import type { AgentMetadata } from './agentMetadata';
import type { Session } from '../types';

function makeSession(id: string, parentSessionId?: string, agent = 'main'): Session {
  return {
    id,
    agent,
    history: [],
    persistentMemorySnapshot: '',
    promptCacheKey: '00000000-0000-4000-8000-000000000000',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

test('setSessionParent rejects descendant parent cycles', async () => {
  const parent = makeSession('relations_parent');
  const child = makeSession('relations_child', parent.id);
  const grandchild = makeSession('relations_grandchild', child.id);
  const sessions = new Map<string, Session>([
    [parent.id, parent],
    [child.id, child],
    [grandchild.id, grandchild],
  ]);

  await assert.rejects(
    setSessionParent({
      getExistingSession: async (sessionId: string) => sessions.get(sessionId) || null,
      saveSession: async () => {},
      saveSessionsMetadata: async () => {},
      notifySessionListUpdated: () => {},
    }, parent.id, grandchild.id),
    /parent cycle/,
  );

  assert.equal(parent.parentSessionId, undefined);
});

test('isolated sessions can resolve direct cross-agent parent and child targets', async () => {
  const cases = [
    { sourceIsolated: true, targetIsolated: false, sourceIsParent: true },
    { sourceIsolated: false, targetIsolated: true, sourceIsParent: true },
    { sourceIsolated: true, targetIsolated: true, sourceIsParent: true },
    { sourceIsolated: true, targetIsolated: false, sourceIsParent: false },
    { sourceIsolated: false, targetIsolated: true, sourceIsParent: false },
    { sourceIsolated: true, targetIsolated: true, sourceIsParent: false },
  ];

  for (const [index, testCase] of cases.entries()) {
    const parent = makeSession(`parent-${index}`, undefined, `parent-agent-${index}`);
    const child = makeSession(`child-${index}`, parent.id, `child-agent-${index}`);
    const source = testCase.sourceIsParent ? parent : child;
    const target = testCase.sourceIsParent ? child : parent;
    const metadata = new Map<string, AgentMetadata>([
      [source.agent!, { isolated: testCase.sourceIsolated }],
      [target.agent!, { isolated: testCase.targetIsolated }],
    ]);
    const sessions = new Map<string, Session>([
      [parent.id, parent],
      [child.id, child],
    ]);

    const resolved = await resolvePermittedSessionTarget({
      getExistingSession: async (sessionId: string) => sessions.get(sessionId) || null,
      getAgentMetadata: (agentName: string) => metadata.get(agentName) || {},
    }, target.id, source.id);

    assert.equal(resolved.sourceSession?.id, source.id);
    assert.equal(resolved.targetSession.id, target.id);
  }
});

test('isolated sessions still reject unrelated cross-agent and sibling targets', async () => {
  const root = makeSession('root', undefined, 'root-agent');
  const isolatedSource = makeSession('isolated-source', root.id, 'isolated-agent');
  const sibling = makeSession('sibling', root.id, 'sibling-agent');
  const unrelated = makeSession('unrelated', undefined, 'unrelated-agent');
  const sessions = new Map<string, Session>([
    [root.id, root],
    [isolatedSource.id, isolatedSource],
    [sibling.id, sibling],
    [unrelated.id, unrelated],
  ]);
  const deps = {
    getExistingSession: async (sessionId: string) => sessions.get(sessionId) || null,
    getAgentMetadata: (agentName: string): AgentMetadata => ({ isolated: agentName === isolatedSource.agent }),
  };

  await assert.rejects(
    resolvePermittedSessionTarget(deps, unrelated.id, isolatedSource.id),
    /isolated and cannot operate on sessions in other agents/,
  );
  await assert.rejects(
    resolvePermittedSessionTarget(deps, sibling.id, isolatedSource.id),
    /isolated and cannot operate on sessions in other agents/,
  );
  await assert.rejects(
    resolvePermittedSessionTarget(deps, isolatedSource.id, unrelated.id),
    /isolated and cannot be accessed from other agents/,
  );
  await assert.rejects(
    resolvePermittedSessionTarget(deps, isolatedSource.id, sibling.id),
    /isolated and cannot be accessed from other agents/,
  );
});
