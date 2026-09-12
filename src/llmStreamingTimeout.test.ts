import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundSafetyBufferingMetadata,
  createStreamingAttemptWatchdog,
  DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
  SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS,
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

test('oversized safety buffering metadata is reduced to bounded useful fields', () => {
  const bounded = boundSafetyBufferingMetadata({
    type: 'safety_buffering',
    use_cases: Array.from({ length: 30 }, () => 'u'.repeat(300)),
    reasons: Array.from({ length: 30 }, () => 'r'.repeat(300)),
    retry_model: 'm'.repeat(500),
    unbounded: 'x'.repeat(10_000),
  });
  assert.equal(bounded.type, 'safety_buffering');
  assert.equal((bounded.use_cases as string[]).length, 5);
  assert.equal((bounded.reasons as string[]).length, 5);
  assert.equal((bounded.retry_model as string).length, 200);
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded).length <= 2048);
});

test('stream watchdog uses three minutes to first activity and one minute between increments', () => {
  assert.equal(DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS, 3 * 60 * 1000);
  assert.equal(DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS, 60 * 1000);
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

test('safety buffering restarts inactivity at ten minutes and later activity retains that window', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: Array<{ kind: string; message: string }> = [];
  const watchdog = createStreamingAttemptWatchdog({
    onTimeout: (error, kind) => fired.push({ kind, message: error.message }),
  });
  watchdog.enterSafetyBuffering({
    type: 'safety_buffering', use_cases: ['cyber'], reasons: ['probes'], retry_model: 'fixture-model',
  });
  assert.deepEqual(timers.entries.map(entry => entry.delayMs), [
    DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
    SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS,
  ]);
  assert.equal(timers.entries[0].cleared, true);
  timers.fire(0);
  assert.deepEqual(fired, []);
  watchdog.enterSafetyBuffering({
    type: 'safety_buffering', use_cases: ['cyber'], reasons: ['updated'], retry_model: 'fixture-model-2',
  });
  assert.equal(timers.entries[1].cleared, true);
  assert.equal(timers.entries[2].delayMs, SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS);
  watchdog.markMeaningfulProgress();
  assert.equal(timers.entries[2].cleared, true);
  assert.equal(timers.entries[3].delayMs, SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS);
  timers.fire(1);
  timers.fire(2);
  assert.deepEqual(fired, []);
  timers.fire(3);
  assert.equal(fired[0].kind, 'content-inactivity');
  assert.match(fired[0].message, /after 600000ms\. Safety buffering metadata: \{"type":"safety_buffering","use_cases":\["cyber"\],"reasons":\["updated"\],"retry_model":"fixture-model-2"\}/);
});

test('safety buffering metadata is attempt-local and is appended when the explicit hard cap wins', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: string[] = [];
  const buffered = createStreamingAttemptWatchdog({
    hardTimeoutMs: 7_000,
    onTimeout: error => fired.push(error.message),
  });
  buffered.enterSafetyBuffering({ type: 'safety_buffering', retry_model: 'fixture-model' });
  timers.fire(1);
  assert.match(fired[0], /explicit caller deadline after 7000ms\. Safety buffering metadata: \{"type":"safety_buffering","retry_model":"fixture-model"\}/);

  const freshTimers = new FakeTimers();
  setStreamingTimeoutTestHooks(freshTimers.hooks);
  const fresh = createStreamingAttemptWatchdog({ onTimeout: () => {} });
  fresh.markMeaningfulProgress();
  assert.equal(freshTimers.entries[1].delayMs, DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS);
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
  watchdog.enterSafetyBuffering({ type: 'safety_buffering' });
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
