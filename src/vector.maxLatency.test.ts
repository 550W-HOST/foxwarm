import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

type FakeTimer = {
  due: number;
  callback: () => void;
  cleared: boolean;
  unrefCalled: boolean;
  unref: () => void;
};

function messageRecord(sessionId: string, seq: number, text = `${sessionId} message ${seq}`) {
  return {
    v: 1,
    kind: 'message' as const,
    sessionId,
    agent: 'test-agent',
    seq,
    timestamp: 1700000000000 + seq,
    role: 'user' as const,
    message: {
      role: 'user' as const,
      parts: [{ text }],
      __meta: { seq, timestamp: 1700000000000 + seq },
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

test('raw archive max-latency scheduling is fixed, serialized, retryable, and shutdown-safe', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vector-max-latency-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  await fs.outputFile(path.join(tempRoot, 'state', 'config.yaml'), 'vector:\n  baseUrl: http://127.0.0.1:11434/v1\n');

  const originalFetch = global.fetch;
  let failNextEmbedding = false;
  let holdNextEmbedding = false;
  let releaseHeldEmbedding: (() => void) | undefined;
  let heldEmbeddingStarted: (() => void) | undefined;
  global.fetch = (async () => {
    if (holdNextEmbedding) {
      holdNextEmbedding = false;
      heldEmbeddingStarted?.();
      await new Promise<void>(resolve => { releaseHeldEmbedding = resolve; });
    }
    if (failNextEmbedding) {
      failNextEmbedding = false;
      throw new Error('injected max-latency embedding failure');
    }
    return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0) }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  let now = 1_000_000;
  const timers = new Set<FakeTimer>();
  const setTimer = (callback: () => void, delayMs: number): FakeTimer => {
    const timer: FakeTimer = {
      due: now + delayMs,
      callback,
      cleared: false,
      unrefCalled: false,
      unref() { timer.unrefCalled = true; },
    };
    timers.add(timer);
    return timer;
  };
  const clearTimer = (timer: FakeTimer) => {
    timer.cleared = true;
    timers.delete(timer);
  };
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    const due = [...timers].filter(timer => !timer.cleared && timer.due <= now).sort((a, b) => a.due - b.due);
    for (const timer of due) {
      timers.delete(timer);
      timer.callback();
    }
    await flushAsyncWork();
  };

  try {
    const store = await import('./session/archiveStore');
    const runtime = await import('./vectorRuntime');
    await store.initArchiveStore();
    runtime.setArchiveIndexTimerHooksForTests({
      now: () => now,
      setTimer,
      clearTimer,
    });
    await runtime.init();
    await runtime.waitForStartupArchiveVectorBackfill();

    const prepare = async (sessionId: string, records: ReturnType<typeof messageRecord>[]) => {
      await store.ensureSessionBranch(sessionId);
      await store.writeArchiveMessages(records);
      store.setVectorCheckpointSync(sessionId, {
        rawLastIndexedSeq: 0,
        rawTailStartSeq: 0,
        lastIndexedBlockId: 0,
      });
    };

    await t.test('first pending raw message arms one non-sliding unref timer', async () => {
      const sessionId = 'latency/non-sliding';
      await prepare(sessionId, [messageRecord(sessionId, 1)]);
      const first = runtime.scheduleSessionArchiveIndex(sessionId, 1, 100, 0);
      const firstStatus = runtime.getArchiveIndexStatus(sessionId);
      assert.equal(firstStatus.maxLatencyDeadline, now + 300_000);
      assert.equal(firstStatus.pendingMessageCount, 1);
      assert.equal([...timers][0]?.unrefCalled, true);

      await advance(120_000);
      await store.writeArchiveMessages([messageRecord(sessionId, 2)]);
      const second = runtime.scheduleSessionArchiveIndex(sessionId, 2, 100, 0);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).maxLatencyDeadline, firstStatus.maxLatencyDeadline);

      await advance(180_000);
      assert.equal(await first, 2);
      assert.equal(await second, 2);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).pendingMessageCount, 0);
      assert.equal(timers.size, 0);
    });

    await t.test('threshold flush cancels the deadline and runs immediately', async () => {
      const sessionId = 'latency/threshold';
      await prepare(sessionId, [messageRecord(sessionId, 1)]);
      const pending = runtime.scheduleSessionArchiveIndex(sessionId, 1, 100, 0);
      assert.equal(timers.size, 1);
      await store.writeArchiveMessages(Array.from({ length: 49 }, (_, index) => messageRecord(sessionId, index + 2)));
      const threshold = runtime.scheduleSessionArchiveIndex(sessionId, 50, 9000, 0);
      assert.equal(timers.size, 0);
      assert.equal(await threshold, 50);
      assert.equal(await pending, 50);
    });

    await t.test('timer failure clears state and a later schedule gets a fresh deadline', async () => {
      const sessionId = 'latency/retry';
      await prepare(sessionId, [messageRecord(sessionId, 1)]);
      failNextEmbedding = true;
      const failed = runtime.scheduleSessionArchiveIndex(sessionId, 1, 100, 0);
      const rejection = assert.rejects(failed, /injected max-latency embedding failure/);
      await advance(300_000);
      await rejection;
      assert.equal(runtime.getArchiveIndexStatus(sessionId).maxLatencyDeadline, undefined);
      assert.equal(timers.size, 0);

      const retried = runtime.scheduleSessionArchiveIndex(sessionId, 1, 100, 0);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).maxLatencyDeadline, now + 300_000);
      await advance(300_000);
      assert.equal(await retried, 1);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).pendingMessageCount, 0);
    });

    await t.test('a suffix arriving during an in-flight flush receives a later fixed deadline', async () => {
      const sessionId = 'latency/in-flight-suffix';
      await prepare(sessionId, [messageRecord(sessionId, 1)]);
      holdNextEmbedding = true;
      const started = new Promise<void>(resolve => { heldEmbeddingStarted = resolve; });
      const first = runtime.scheduleSessionArchiveIndex(sessionId, 1, 9000, 0);
      await started;

      await store.writeArchiveMessages([messageRecord(sessionId, 2)]);
      const suffix = runtime.scheduleSessionArchiveIndex(sessionId, 2, 100, 0);
      const suffixDeadline = runtime.getArchiveIndexStatus(sessionId).maxLatencyDeadline;
      assert.equal(suffixDeadline, now + 300_000);
      releaseHeldEmbedding?.();
      for (let attempt = 0; attempt < 50 && runtime.getArchiveIndexStatus(sessionId).lastIndexedSeq < 1; attempt += 1) {
        await flushAsyncWork();
      }
      const afterFirst = runtime.getArchiveIndexStatus(sessionId);
      assert.equal(afterFirst.lastIndexedSeq, 1);
      assert.equal(afterFirst.pendingMessageCount, 1);
      assert.equal(afterFirst.maxLatencyDeadline, suffixDeadline);
      await advance(300_000);
      assert.deepEqual(await Promise.all([first, suffix]), [2, 2]);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).pendingMessageCount, 0);
    });

    await t.test('forced indexing and rename lifecycle cancel pending deadlines', async () => {
      const forcedSessionId = 'latency/forced-takeover';
      await prepare(forcedSessionId, [messageRecord(forcedSessionId, 1)]);
      const scheduled = runtime.scheduleSessionArchiveIndex(forcedSessionId, 1, 100, 0);
      assert.equal(timers.size, 1);
      const forced = runtime.indexSessionArchive(forcedSessionId, 1, 0);
      assert.equal(timers.size, 0);
      assert.deepEqual(await Promise.all([scheduled, forced]), [1, 1]);

      const renamedSessionId = 'latency/rename';
      await prepare(renamedSessionId, [messageRecord(renamedSessionId, 1)]);
      const pendingRename = runtime.scheduleSessionArchiveIndex(renamedSessionId, 1, 100, 0);
      assert.equal(timers.size, 1);
      await runtime.renameSessionArchiveIndex(renamedSessionId, `${renamedSessionId}-new`);
      assert.equal(timers.size, 0);
      assert.equal(await pendingRename, 0);
    });

    await t.test('fork checkpoint copy uses committed target caps rather than source current checkpoint', async () => {
      const parentId = 'latency/fork-parent';
      const childId = 'latency/fork-child';
      await store.ensureSessionBranch(parentId);
      await store.writeArchiveMessages(Array.from({ length: 5 }, (_, index) => messageRecord(parentId, index + 1)) as any);
      store.setVectorCheckpointSync(parentId, { rawLastIndexedSeq: 5, rawTailStartSeq: 4, lastIndexedBlockId: 3 });
      await store.ensureSessionBranch(childId, { parentSessionId: parentId, forkMessageSeq: 2, forkBlockId: 1 });
      await runtime.copySessionArchiveIndexCheckpoint(parentId, childId);
      const status = runtime.getArchiveIndexStatus(childId);
      assert.equal(status.lastIndexedSeq, 2);
      assert.equal(status.tailStartSeq, 3);
      assert.equal(status.lastIndexedBlockId, 1);
      assert.equal(status.pendingMessageCount, 0);
    });

    await t.test('failed-creation derived reset clears dense checkpoint for lower-sequence ID reuse', async () => {
      const sessionId = 'latency/reused-target';
      await prepare(sessionId, [messageRecord(sessionId, 1, 'stale lifetime')]);
      await runtime.indexSessionArchive(sessionId, 1, 0);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).lastIndexedSeq, 1);
      await store.rollbackUncommittedSessionArchive(sessionId);
      await runtime.resetSessionArchiveDerived(sessionId);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).lastIndexedSeq, 0);
      await store.ensureSessionBranch(sessionId);
      await store.writeArchiveMessages([messageRecord(sessionId, 1, 'fresh lifetime')] as any);
      await runtime.indexSessionArchive(sessionId, 1, 0);
      assert.equal(runtime.getArchiveIndexStatus(sessionId).lastIndexedSeq, 1);
    });

    await t.test('shutdown cancels pending deadlines and resolves pending schedules', async () => {
      const sessionId = 'latency/shutdown';
      await prepare(sessionId, [messageRecord(sessionId, 1)]);
      const pending = runtime.scheduleSessionArchiveIndex(sessionId, 1, 100, 0);
      assert.equal(timers.size, 1);
      await runtime.shutdown();
      assert.equal(timers.size, 0);
      assert.equal(await pending, 0);
    });
  } finally {
    try {
      const runtime = await import('./vectorRuntime');
      runtime.setArchiveIndexTimerHooksForTests();
      await runtime.shutdown();
    } catch {
      // Best-effort cleanup for partially initialized test state.
    }
    global.fetch = originalFetch;
    await fs.remove(tempRoot);
  }
});
