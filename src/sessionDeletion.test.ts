import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import * as sessionManager from './sessionManager';
import { deleteSessionLifecycle, SessionDeletionError } from './sessionDeletion';
import { deleteSessionForSource } from './toolsSessionAgent/sessionCrud';
import { handleSessionCommand } from './commands/sessionCmd';
import type { Session } from './types';
import { getAgentDir } from './config';

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createSession(sessionId: string, parentSessionId?: string, aliases?: string[]): Promise<Session> {
  const session = await sessionManager.getSession(sessionId);
  session.agent = sessionId.includes('/') ? sessionId.split('/').slice(0, -1).join('/') : 'main';
  session.history = [];
  session.busy = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };
  session.parentSessionId = parentSessionId;
  session.aliases = aliases;
  await sessionManager.saveSession(session.id);
  return session;
}

function errorCode(code: string) {
  return (error: any) => error instanceof SessionDeletionError && error.code === code;
}

test('single-session deletion shares alias/self, blocker, busy, graph, child-detach, command, and tool semantics', async () => {
  await sessionManager.loadSessions();
  const sourceId = id('delete-source');
  const sourceAlias = `${sourceId}-alias`;
  const cleanup = new Set<string>();
  let blockedChannel: { channelId: string; conversationId: string } | undefined;
  try {
    const source = await createSession(sourceId, undefined, [sourceAlias]); cleanup.add(sourceId);

    await assert.rejects(
      deleteSessionForSource({ sessionId: sourceAlias }, sourceId),
      /Cannot delete current session/,
    );
    assert.ok(sessionManager.getAllSessions().has(sourceId));

    const aliasTargetId = id('delete-alias-target');
    const aliasTarget = await createSession(aliasTargetId, undefined, [`${aliasTargetId}-old`]); cleanup.add(aliasTargetId);
    assert.match(await deleteSessionForSource({ sessionId: aliasTarget.aliases![0] }, sourceId), /deleted successfully/);
    assert.equal(sessionManager.getAllSessions().has(aliasTargetId), false);

    const commandTargetId = id('delete-command-target');
    await createSession(commandTargetId); cleanup.add(commandTargetId);
    const commandReplies: string[] = [];
    await handleSessionCommand({
      platform: 'test', channelId: 'test', channelType: 'test', channelUserId: 'room', conversationId: 'room',
      reply: async (text: string) => { commandReplies.push(String(text)); }, sendTyping: async () => {},
    } as any, ['delete', commandTargetId], sourceId, source as any);
    assert.deepEqual(commandReplies, [`✅ Session \`${commandTargetId}\` deleted.`]);

    const blockedId = id('delete-blocked');
    await createSession(blockedId); cleanup.add(blockedId);
    blockedChannel = { channelId: 'telegram-delete-test', conversationId: `room-${blockedId}` };
    await sessionManager.attachChannelDurably(blockedChannel.channelId, blockedChannel.conversationId, blockedId);
    await assert.rejects(
      deleteSessionLifecycle({ requestedSessionId: blockedId, sourceSessionId: sourceId }),
      errorCode('SESSION_DELETE_CHANNEL_BLOCKED'),
    );
    assert.ok(sessionManager.getAllSessions().has(blockedId));
    sessionManager.detachChannel(blockedChannel.channelId, blockedChannel.conversationId);
    blockedChannel = undefined;

    const busyId = id('delete-busy');
    const busy = await createSession(busyId); cleanup.add(busyId);
    busy.busy = true;
    busy.queue = [{ type: 'user', parts: [{ text: 'queued before delete' }] }];
    await sessionManager.saveSession(busy.id);
    const busyResult = await deleteSessionLifecycle({ requestedSessionId: busyId, sourceSessionId: sourceId });
    assert.equal(busyResult.status, 'busy');
    if (busyResult.status === 'busy') {
      assert.deepEqual(busyResult.busySessionIds, [busyId]);
      assert.equal(busyResult.droppedQueueItems, 1);
    }
    assert.ok(sessionManager.getAllSessions().has(busyId));
    assert.equal(busy.queue.length, 0);
    assert.equal(busy.stopping, true);
    busy.busy = false; delete busy.stopping; await sessionManager.saveSession(busy.id);

    const staleRootId = id('delete-stale-root');
    const staleChildId = `${staleRootId}-child`;
    await createSession(staleRootId); cleanup.add(staleRootId);
    const staleChild = await createSession(staleChildId, staleRootId); cleanup.add(staleChildId);
    await assert.rejects(
      deleteSessionLifecycle({
        requestedSessionId: staleRootId,
        sourceSessionId: sourceId,
        beforeRevalidateForTests: async () => {
          delete staleChild.parentSessionId;
          await sessionManager.saveSession(staleChild.id);
        },
      }),
      errorCode('SESSION_DELETE_TREE_CHANGED'),
    );
    assert.ok(sessionManager.getAllSessions().has(staleRootId));

    const staleSourceTargetId = id('delete-stale-source-target');
    await createSession(staleSourceTargetId); cleanup.add(staleSourceTargetId);
    let sourceFenceChecks = 0;
    await assert.rejects(
      deleteSessionLifecycle({
        requestedSessionId: staleSourceTargetId,
        sourceSessionId: sourceId,
        assertSourceCurrent: () => {
          sourceFenceChecks += 1;
          if (sourceFenceChecks === 3) throw Object.assign(new Error('stale source generation'), { code: 'MAIN_MANAGEMENT_SOURCE_STALE' });
        },
      }),
      (error: any) => error?.code === 'MAIN_MANAGEMENT_SOURCE_STALE',
    );
    assert.equal(sourceFenceChecks, 3);
    assert.ok(sessionManager.getAllSessions().has(staleSourceTargetId), 'stale source fence fails before detach/delete');

    const claimedRootId = id('delete-worker-claim-root');
    const claimedChildId = `${claimedRootId}-child`;
    await createSession(claimedRootId); cleanup.add(claimedRootId);
    const claimedChild = await createSession(claimedChildId, claimedRootId); cleanup.add(claimedChildId);
    let workerIngressCalls = 0;
    sessionManager.setSessionWorkerEnqueueSink(async () => { workerIngressCalls += 1; });
    try {
      const claimedResult = await deleteSessionLifecycle({
        requestedSessionId: claimedRootId,
        sourceSessionId: sourceId,
        beforeFinalMutationForTests: async () => {
          await assert.rejects(
            sessionManager.enqueueSessionItem(claimedRootId, { type: 'user', parts: [{ text: 'late worker ingress' }] }),
            (error: any) => error?.code === 'SESSION_DELETE_IN_PROGRESS' && error?.statusCode === 409,
          );
          await assert.rejects(
            sessionManager.setSessionParent(claimedChildId, sourceId),
            (error: any) => error?.code === 'SESSION_DELETE_IN_PROGRESS' && error?.statusCode === 409,
          );
          assert.equal(workerIngressCalls, 0, 'claim rejects before Worker sink/spawn/mailbox work');
          assert.equal(claimedChild.parentSessionId, claimedRootId, 'claim rejects before catalog relation mutation');
        },
      });
      assert.equal(claimedResult.status, 'deleted');
      assert.equal(claimedChild.parentSessionId, undefined, 'owning deletion claim may detach the surviving child');
    } finally {
      sessionManager.setSessionWorkerEnqueueSink(undefined);
    }

    const rootId = id('delete-parent');
    const childId = `${rootId}-child`;
    const grandchildId = `${childId}-grandchild`;
    await createSession(rootId); cleanup.add(rootId);
    const child = await createSession(childId, rootId); cleanup.add(childId);
    const grandchild = await createSession(grandchildId, childId); cleanup.add(grandchildId);
    const result = await deleteSessionLifecycle({ requestedSessionId: rootId, sourceSessionId: sourceId });
    assert.deepEqual(result, {
      status: 'deleted', includeDescendants: false, deletedCount: 1,
      deletedSessionIds: [rootId], detachedChildSessionIds: [childId],
    });
    assert.equal(sessionManager.getAllSessions().has(rootId), false);
    assert.equal(child.parentSessionId, undefined);
    assert.equal(grandchild.parentSessionId, childId);

    const isolatedAgent = id('isolated-delete-agent');
    const isolatedSourceId = `${isolatedAgent}/main`;
    const isolatedTargetId = id('isolated-delete-target');
    await fs.ensureDir(getAgentDir(isolatedAgent));
    await createSession(isolatedSourceId); cleanup.add(isolatedSourceId);
    await createSession(isolatedTargetId); cleanup.add(isolatedTargetId);
    await sessionManager.setAgentIsolation(isolatedAgent, 'sandbox-test');
    await assert.rejects(
      deleteSessionForSource({ sessionId: isolatedTargetId }, isolatedSourceId),
      /Isolated session cannot use delete_session tool/,
    );
    assert.ok(sessionManager.getAllSessions().has(isolatedTargetId));
    await sessionManager.setAgentIsolation(isolatedAgent, undefined);
  } finally {
    if (blockedChannel) sessionManager.detachChannel(blockedChannel.channelId, blockedChannel.conversationId);
    for (const sessionId of [...cleanup].reverse()) {
      const session = sessionManager.getAllSessions().get(sessionId);
      if (session) { session.busy = false; session.queue = []; delete session.stopping; }
      await sessionManager.deleteSession(sessionId).catch(() => false);
    }
  }
});
