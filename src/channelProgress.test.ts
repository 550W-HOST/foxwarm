import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelProgressCoordinator, type ChannelProgressClock, type ChannelProgressTarget } from './channelProgress';

type PendingTimer = { id: number; at: number; callback: () => void; cancelled: boolean };

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers: PendingTimer[] = [];
  const clock: ChannelProgressClock = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      const timer = { id: nextId++, at: now + delayMs, callback, cancelled: false };
      timers.push(timer);
      return timer as any;
    },
    clearTimer: timer => { (timer as any as PendingTimer).cancelled = true; },
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    while (true) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      due.cancelled = true;
      now = due.at;
      due.callback();
      await Promise.resolve();
    }
    now = end;
    await Promise.resolve();
  };
  const activeTimerCount = () => timers.filter(timer => !timer.cancelled).length;
  return { clock, advance, activeTimerCount };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function target(id: string, intervalMs: number, sent: string[], fail = false): ChannelProgressTarget {
  return {
    channelInstanceId: id,
    conversationId: 'room',
    intervalMs,
    send: async text => {
      if (fail) throw new Error('presentation failed');
      sent.push(text);
    },
  };
}

test('per-target fixed timers and baselines remain independent', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const fast: string[] = [];
  const slow: string[] = [];
  coordinator.report('turn', [target('fast', 30_000, fast), target('slow', 60_000, slow)], {
    type: 'tool-calls-start', calls: [{ id: 'a', name: 'read' }],
  });
  await fake.advance(20_000);
  coordinator.report('turn', [target('fast', 30_000, fast), target('slow', 60_000, slow)], {
    type: 'tool-calls-start', calls: [{ id: 'b', name: 'exec' }],
  });
  await fake.advance(10_000);
  assert.deepEqual(fast, ['⏳ Tools: read ×1 · exec ×1']);
  assert.deepEqual(slow, []);
  assert.equal(coordinator.decorate('turn', { channelInstanceId: 'fast', conversationId: 'room' }, 'answer'), 'answer');
  assert.equal(coordinator.decorate('turn', { channelInstanceId: 'slow', conversationId: 'room' }, 'answer'), 'Tools: read ×1 · exec ×1\n\nanswer');
  await fake.advance(30_000);
  assert.deepEqual(slow, ['⏳ Tools running: read ×1 · exec ×1']);
});

test('timed report consumes starts and long-running tools emit bounded heartbeats', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const sent: string[] = [];
  const one = target('one', 30_000, sent);
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'a', name: 'exec' }] });
  await fake.advance(30_000);
  await fake.advance(30_000);
  assert.deepEqual(sent, ['⏳ Tools: exec ×1', '⏳ Tools running: exec ×1']);
  coordinator.report('turn', [one], { type: 'tool-calls-finish', results: [{ id: 'a', name: 'exec', status: 'success' }] });
  await fake.advance(30_000);
  assert.equal(sent.length, 2);
  assert.equal(coordinator.decorate('turn', { channelInstanceId: 'one', conversationId: 'room' }, 'done'), 'done');
});

test('prepend consumes only one target and final flush sends pending standalone summary', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const a: string[] = [];
  const b: string[] = [];
  coordinator.report('turn', [target('a', 60_000, a), target('b', 60_000, b)], {
    type: 'tool-calls-start', calls: [{ id: 'one', name: 'read' }, { id: 'two', name: 'read' }],
  });
  assert.equal(coordinator.decorate('turn', { channelInstanceId: 'a', conversationId: 'room' }, 'partial'), 'Tools: read ×2\n\npartial');
  await coordinator.finish('turn');
  assert.deepEqual(a, []);
  assert.deepEqual(b, ['⏳ Tools: read ×2']);
  assert.equal(coordinator.sizeForTests(), 0);
});

test('terminal flush includes activity started after an earlier decorated batch', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const sent: string[] = [];
  const one = target('one', 30_000, sent);
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'read', name: 'read' }] });
  assert.equal(coordinator.decorate('turn', { channelInstanceId: 'one', conversationId: 'room' }, 'intermediate'), 'Tools: read ×1\n\nintermediate');
  coordinator.report('turn', [one], { type: 'tool-calls-finish', results: [{ id: 'read', name: 'read', status: 'success' }] });
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'exec', name: 'exec' }] });
  await coordinator.finish('turn');
  assert.deepEqual(sent, ['⏳ Tools: exec ×1']);
});

test('exact wait tool activity is presentation-silent while mixed tools still report', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const sent: string[] = [];
  const one = target('one', 30_000, sent);

  coordinator.report('wait-only', [one], { type: 'tool-calls-start', calls: [{ id: 'wait-1', name: 'wait' }] });
  coordinator.report('wait-only', [one], { type: 'tool-calls-finish', results: [{ id: 'wait-1', name: 'wait', status: 'success' }] });
  coordinator.report('wait-only', [one], { type: 'tool-calls-start', calls: [{ id: 'wait-2', name: 'wait' }] });
  assert.equal(coordinator.sizeForTests(), 0);
  assert.equal(fake.activeTimerCount(), 0);
  await coordinator.finish('wait-only');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);

  coordinator.report('mixed', [one], {
    type: 'tool-calls-start',
    calls: [{ id: 'wait-3', name: 'wait' }, { id: 'read-1', name: 'read' }],
  });
  assert.equal(coordinator.decorate('mixed', { channelInstanceId: 'one', conversationId: 'room' }, 'answer'), 'Tools: read ×1\n\nanswer');
  coordinator.report('mixed', [one], {
    type: 'tool-calls-finish',
    results: [{ id: 'wait-3', name: 'wait', status: 'success' }, { id: 'read-1', name: 'read', status: 'success' }],
  });
  await coordinator.finish('mixed');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
});

test('wait after previously consumed activity creates no later terminal progress', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const sent: string[] = [];
  const one = target('one', 30_000, sent);
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'read', name: 'read' }] });
  assert.equal(coordinator.decorate('turn', { channelInstanceId: 'one', conversationId: 'room' }, 'intermediate'), 'Tools: read ×1\n\nintermediate');
  coordinator.report('turn', [one], { type: 'tool-calls-finish', results: [{ id: 'read', name: 'read', status: 'success' }] });
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'wait', name: 'wait' }] });
  coordinator.report('turn', [one], { type: 'tool-calls-finish', results: [{ id: 'wait', name: 'wait', status: 'success' }] });
  await coordinator.finish('turn');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
});

test('wait-only late source refreshes an existing timer target without adding activity', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const sentA: string[] = [];
  const sentB: string[] = [];
  const oldTarget = target('one', 30_000, sentA);
  const latestTarget = target('one', 30_000, sentB);
  coordinator.report('turn', [oldTarget], { type: 'tool-calls-start', calls: [{ id: 'read', name: 'read' }] });
  coordinator.report('turn', [latestTarget], { type: 'tool-calls-start', calls: [{ id: 'wait', name: 'wait' }] });
  await fake.advance(30_000);
  assert.deepEqual(sentA, []);
  assert.deepEqual(sentB, ['⏳ Tools: read ×1']);
  coordinator.reset();
});

test('blocked timer send keeps one chain and preserves starts for the next fixed timer', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const blocked = deferred();
  const sent: string[] = [];
  let calls = 0;
  const one: ChannelProgressTarget = {
    channelInstanceId: 'one', conversationId: 'room', intervalMs: 30_000,
    send: async text => {
      sent.push(text);
      calls += 1;
      if (calls === 1) await blocked.promise;
    },
  };
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'read', name: 'read' }] });
  await fake.advance(30_000);
  assert.deepEqual(sent, ['⏳ Tools: read ×1']);
  assert.equal(fake.activeTimerCount(), 0);
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'exec', name: 'exec' }] });
  assert.equal(fake.activeTimerCount(), 0, 'new activity must not arm beside an in-flight timer send');
  blocked.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(fake.activeTimerCount(), 1);
  await fake.advance(30_000);
  assert.deepEqual(sent, ['⏳ Tools: read ×1', '⏳ Tools: exec ×1']);
  assert.equal(fake.activeTimerCount(), 1, 'one heartbeat chain remains scheduled');
  coordinator.reset();
});

test('finish with a never-settling timer send resolves promptly, drops the competing flush, and prevents rearm', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const blocked = deferred();
  const sent: string[] = [];
  let calls = 0;
  const one: ChannelProgressTarget = {
    channelInstanceId: 'one', conversationId: 'room', intervalMs: 30_000,
    send: async text => {
      sent.push(text);
      calls += 1;
      if (calls === 1) await blocked.promise;
    },
  };
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'read', name: 'read' }] });
  await fake.advance(30_000);
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'exec', name: 'exec' }] });
  await coordinator.finish('turn');
  assert.deepEqual(sent, ['⏳ Tools: read ×1']);
  assert.equal(fake.activeTimerCount(), 0);
  assert.equal(coordinator.sizeForTests(), 0);
  await fake.advance(60_000);
  assert.equal(sent.length, 1);
  blocked.resolve();
});

test('reset fences a queued terminal flush before it can call the captured target', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const sent: string[] = [];
  const one = target('one', 30_000, sent);
  coordinator.report('turn', [one], { type: 'tool-calls-start', calls: [{ id: 'exec', name: 'exec' }] });
  const finish = coordinator.finish('turn');
  coordinator.reset();
  await finish;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(sent, []);
  assert.equal(fake.activeTimerCount(), 0);
  assert.equal(coordinator.sizeForTests(), 0);
});

test('empty turns, failed presentation, sanitization, and reset do not leak state', async () => {
  const fake = fakeClock();
  const coordinator = new ChannelProgressCoordinator(fake.clock);
  const sent: string[] = [];
  coordinator.report('empty', [target('empty', 30_000, sent)], { type: 'llm-start' });
  assert.equal(coordinator.sizeForTests(), 0);
  coordinator.report('turn', [target('bad', 30_000, sent, true)], {
    type: 'tool-calls-start', calls: [{ id: 'x', name: 're\n`ad*<unsafe>' }],
  });
  await fake.advance(30_000);
  assert.equal(coordinator.sizeForTests(), 1);
  assert.equal(coordinator.decorate('turn', { channelInstanceId: 'bad', conversationId: 'room' }, 'ok'), 'Tools: readunsafe ×1\n\nok');
  coordinator.reset();
  assert.equal(coordinator.sizeForTests(), 0);
  await fake.advance(60_000);
});
