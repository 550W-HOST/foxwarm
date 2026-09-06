import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamingAttemptWatchdog,
  DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
  setStreamingTimeoutTestHooks,
} from './llmStreamingTimeout';

class FakeTimers {
  entries: Array<{ callback: () => void; delayMs: number; cleared: boolean; unrefs: number; timer: any }> = [];
  hooks = {
    set: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, cleared: false, unrefs: 0, timer: undefined as any };
      entry.timer = { unref: () => { entry.unrefs += 1; } };
      this.entries.push(entry);
      return entry.timer;
    },
    clear: (timer: any) => {
      const entry = this.entries.find(candidate => candidate.timer === timer);
      if (entry) entry.cleared = true;
    },
  };
  fire(index: number) { this.entries[index].callback(); }
}

afterEach(() => setStreamingTimeoutTestHooks());

test('stream watchdog uses three minutes to first content and one minute between increments', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: string[] = [];
  const watchdog = createStreamingAttemptWatchdog({ onTimeout: (_error, kind) => fired.push(kind) });
  assert.equal(timers.entries[0].delayMs, DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS);
  assert.equal(timers.entries[0].unrefs, 1);
  watchdog.markMeaningfulProgress();
  assert.equal(timers.entries[0].cleared, true);
  assert.equal(timers.entries[1].delayMs, DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS);
  watchdog.markMeaningfulProgress();
  assert.equal(timers.entries[1].cleared, true);
  assert.equal(timers.entries[2].delayMs, DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS);
  timers.fire(1);
  assert.deepEqual(fired, []);
  timers.fire(2);
  assert.deepEqual(fired, ['content-inactivity']);
});

test('explicit hard deadline is independent and earliest timeout wins', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: Array<{ kind: string; message: string }> = [];
  createStreamingAttemptWatchdog({
    hardTimeoutMs: 7_000,
    onTimeout: (error, kind) => fired.push({ kind, message: error.message }),
  });
  assert.deepEqual(timers.entries.map(entry => entry.delayMs), [DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS, 7_000]);
  timers.fire(1);
  assert.equal(fired[0].kind, 'hard-deadline');
  assert.match(fired[0].message, /explicit caller deadline.*7000ms/);
  timers.fire(0);
  assert.equal(fired.length, 1);
});

test('successful completion clears first-content, inactivity, and hard timers', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const watchdog = createStreamingAttemptWatchdog({ hardTimeoutMs: 9_000, onTimeout: () => assert.fail('must not time out') });
  watchdog.markMeaningfulProgress();
  watchdog.finish();
  assert.ok(timers.entries.every(entry => entry.cleared));
  for (const entry of timers.entries) entry.callback();
});

test('progress can continue beyond five minutes without an implicit overall streaming cap', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: string[] = [];
  const watchdog = createStreamingAttemptWatchdog({ onTimeout: (_error, kind) => fired.push(kind) });
  for (let minute = 0; minute < 7; minute += 1) {
    watchdog.markMeaningfulProgress();
    const previous = timers.entries.at(-2);
    if (previous) previous.callback();
    assert.deepEqual(fired, []);
  }
  assert.equal(timers.entries.some(entry => entry.delayMs === 5 * 60 * 1000), false);
  watchdog.finish();
});
