import test from 'node:test';
import assert from 'node:assert/strict';
import * as sessionManager from '../sessionManager';
import * as archiveStore from '../session/archiveStore';
import * as vector from '../vector';
import type { Session } from '../types';
import { resolveMemorySearchOptions } from '../tools/vectorTools';
import { tool_recall } from './archiveRecall';

function createSession(id: string): Session {
  return {
    id,
    aliases: [`${id}-old`],
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

function installArchiveFixtures() {
  const messages: any[] = [
    { seq: 1, message: { role: 'user', parts: [{ text: 'archived one' }], __meta: { timestamp: 1000 } } },
    { seq: 2, message: { role: 'model', parts: [{ text: 'archived two' }], __meta: { timestamp: 2000 } } },
  ];
  const blocks: any[] = [{
    id: 1,
    level: 1,
    sourceKind: 'message',
    sourceStart: 1,
    sourceEnd: 2,
    rawStartSeq: 1,
    rawEndSeq: 2,
    summary: 'summary one two',
  }];
  const originals = {
    messages: sessionManager.getArchivedMessages,
    blocks: sessionManager.getArchivedBlocks,
  };
  (sessionManager as any).getArchivedMessages = async (_id: string, options: any = {}) => {
    const selected = messages.filter(record => (options.startSeq === undefined || record.seq >= options.startSeq)
      && (options.endSeq === undefined || record.seq <= options.endSeq));
    return {
      records: selected,
      totalMatched: selected.length,
      returnedCount: selected.length,
      availableRange: { startSeq: 1, endSeq: 2 },
      requestedRange: { startSeq: options.startSeq, endSeq: options.endSeq },
    };
  };
  (sessionManager as any).getArchivedBlocks = async (_id: string, options: any = {}) => {
    const selected = blocks.filter(record => (options.startId === undefined || record.id >= options.startId)
      && (options.endId === undefined || record.id <= options.endId));
    return {
      records: selected,
      totalMatched: selected.length,
      returnedCount: selected.length,
      requestedRange: { startId: options.startId, endId: options.endId },
    };
  };
  return () => {
    (sessionManager as any).getArchivedMessages = originals.messages;
    (sessionManager as any).getArchivedBlocks = originals.blocks;
  };
}

test('detached current recall exact targets and aliases match legacy output without source lookup', async () => {
  const session = createSession(`detached_recall_${Date.now()}`);
  const restoreArchive = installArchiveFixtures();
  const originals = {
    getExisting: sessionManager.getExistingSession,
    getSession: sessionManager.getSession,
    getCatalog: sessionManager.getSessionCatalog,
    isolated: sessionManager.isSessionEffectivelyIsolated,
  };
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  (sessionManager as any).getExistingSession = async (id: string) => id === session.id || session.aliases?.includes(id) ? session : null;
  (sessionManager as any).getSession = async () => session;
  (sessionManager as any).getSessionCatalog = (id: string) => id === session.id || session.aliases?.includes(id) ? session : undefined;
  const cases: any[] = [
    { target: 'overview' },
    { target: 'blocks' },
    { target: 'B#1' },
    { target: 'msg:B#1' },
    { target: 'msg#1-2', contentFilter: 'archived', toolDetail: 'full', previewLength: 2000 },
    { sessionId: session.aliases![0], target: 'overview' },
  ];

  try {
    const legacy = await Promise.all(cases.map(args => tool_recall(args, { sessionId: session.id } as any)));
    (sessionManager as any).getExistingSession = async () => { throw new Error('global source lookup forbidden'); };
    (sessionManager as any).getSession = async () => { throw new Error('global source get forbidden'); };
    const ctx: any = { sessionId: session.id, session, persistCurrentSession: async () => {}, sessionPlacement: 'session-worker' };
    const detached = await Promise.all(cases.map(args => tool_recall(args, ctx)));
    assert.deepEqual(detached, legacy);
  } finally {
    restoreArchive();
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).getSession = originals.getSession;
    (sessionManager as any).getSessionCatalog = originals.getCatalog;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
  }
});

test('detached recall preserves isolated own access and legacy cross-target denial', async () => {
  const session = createSession(`detached_recall_isolated_${Date.now()}`);
  const restoreArchive = installArchiveFixtures();
  const originals = {
    getExisting: sessionManager.getExistingSession,
    getCatalog: sessionManager.getSessionCatalog,
    isolated: sessionManager.isSessionEffectivelyIsolated,
  };
  (sessionManager as any).getSessionCatalog = (id: string) => id === session.id ? session : undefined;
  (sessionManager as any).isSessionEffectivelyIsolated = (candidate: Session | undefined) => candidate === session;
  try {
    (sessionManager as any).getExistingSession = async () => { throw new Error('own source lookup forbidden'); };
    const own = String(await tool_recall({ target: 'overview' }, {
      sessionId: session.id, session, persistCurrentSession: async () => {},
    } as any));
    assert.match(own, /Recall overview/);

    (sessionManager as any).getExistingSession = async (id: string) => id === session.id ? session : null;
    await assert.rejects(() => tool_recall({ sessionId: 'other/session', target: 'overview' }, {
      sessionId: session.id, session, persistCurrentSession: async () => {},
    } as any), { message: 'Isolated session can only use recall for sessions under its own agent (main).' });
  } finally {
    restoreArchive();
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).getSessionCatalog = originals.getCatalog;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
  }
});

test('recall no-hook and mismatched owners use catalog lookup without semantic hydration', async () => {
  const session = createSession(`legacy_recall_${Date.now()}`);
  const clone = createSession(`${session.id}_clone`);
  const restoreArchive = installArchiveFixtures();
  const originals = {
    getExisting: sessionManager.getExistingSession,
    getCatalog: sessionManager.getSessionCatalog,
    isolated: sessionManager.isSessionEffectivelyIsolated,
  };
  let catalogLookups = 0;
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  (sessionManager as any).getExistingSession = async () => { throw new Error('semantic hydration forbidden'); };
  (sessionManager as any).getSessionCatalog = () => { catalogLookups += 1; return session; };
  try {
    await tool_recall({ sessionId: session.id, target: 'overview' }, { sessionId: session.id, session } as any);
    await tool_recall({ sessionId: session.id, target: 'overview' }, {
      sessionId: session.id, session: clone, persistCurrentSession: async () => {},
    } as any);
    assert.equal(catalogLookups, 2);
  } finally {
    restoreArchive();
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).getSessionCatalog = originals.getCatalog;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
  }
});

test('detached vector scope resolution matches legacy for session, alias, and agent scopes', async () => {
  const session = createSession(`detached_vector_scope_${Date.now()}`);
  const originals = {
    getSession: sessionManager.getSession,
    getExisting: sessionManager.getExistingSession,
    getCatalog: sessionManager.getSessionCatalog,
    isolated: sessionManager.isSessionEffectivelyIsolated,
    lineage: archiveStore.getVectorSearchLineage,
    search: vector.search,
  };
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  (sessionManager as any).getSession = async () => session;
  (sessionManager as any).getExistingSession = async () => session;
  (sessionManager as any).getSessionCatalog = () => session;
  (archiveStore as any).getVectorSearchLineage = async (): Promise<any[]> => [];
  const requests = [
    { scope: 'current-session' as const },
    { targetSessionId: session.aliases![0] },
    { scope: 'current-agent' as const, targetAgentName: 'main' },
  ];

  try {
    const legacy = await Promise.all(requests.map(request => resolveMemorySearchOptions(request, { sessionId: session.id } as any)));
    (sessionManager as any).getSession = async () => { throw new Error('global vector source lookup forbidden'); };
    (sessionManager as any).getExistingSession = async () => { throw new Error('global vector target lookup forbidden'); };
    const ctx: any = { sessionId: session.id, session, persistCurrentSession: async () => {} };
    const detached = await Promise.all(requests.map(request => resolveMemorySearchOptions(request, ctx)));
    assert.deepEqual(detached, legacy);

    const vectorOptions: any[] = [];
    (vector as any).search = async (...callArgs: any[]): Promise<any[]> => { vectorOptions.push(callArgs[3]); return []; };
    for (const args of [
      { vector_query: 'needle' },
      { vector_query: 'needle', scope: 'current-session' },
      { vector_query: 'needle', scope: 'current-agent' },
      { vector_query: 'needle', sessionId: `  ${session.aliases![0]}  `, agentName: ' main ' },
    ]) {
      assert.match(String(await tool_recall(args, ctx)), /No archived source messages or blocks found/);
    }
    assert.deepEqual(vectorOptions[0], { agent: 'main', preferBlocks: undefined });
    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    const isolated = await resolveMemorySearchOptions({ scope: 'current-agent' }, ctx);
    assert.equal(isolated.effectiveScope, 'current-session');
    assert.deepEqual(isolated.searchOptions, { sessionIds: [session.id, ...session.aliases!] });
    (sessionManager as any).isSessionEffectivelyIsolated = () => false;
    await assert.rejects(() => resolveMemorySearchOptions({ targetSessionId: 'other/session' }, ctx), /global vector target lookup forbidden/);
  } finally {
    (sessionManager as any).getSession = originals.getSession;
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).getSessionCatalog = originals.getCatalog;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
    (archiveStore as any).getVectorSearchLineage = originals.lineage;
    (vector as any).search = originals.search;
  }
});
