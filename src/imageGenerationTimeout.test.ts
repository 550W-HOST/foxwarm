import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamingAttemptWatchdog,
  DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
  IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS,
  setStreamingTimeoutTestHooks,
} from './llmStreamingTimeout';

class FakeTimers {
  entries: Array<{ callback: () => void; delayMs: number; cleared: boolean; timer: any }> = [];
  hooks = {
    set: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, cleared: false, timer: undefined as any };
      entry.timer = { unref: () => {} };
      this.entries.push(entry);
      return entry.timer;
    },
    clear: (timer: any) => {
      const entry = this.entries.find(candidate => candidate.timer === timer);
      if (entry) entry.cleared = true;
    },
  };
  fire(index: number) { this.entries[index].callback(); }
  last() { return this.entries[this.entries.length - 1]; }
}

afterEach(() => setStreamingTimeoutTestHooks());

test('an active hosted image call holds a ten-minute window instead of sixty seconds', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: string[] = [];
  const watchdog = createStreamingAttemptWatchdog({ onTimeout: (_error, kind) => fired.push(kind) });

  watchdog.markMeaningfulProgress();
  assert.equal(timers.last().delayMs, DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS);

  watchdog.beginImageGeneration('ig_1');
  assert.equal(timers.last().delayMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);

  // Ordinary text progress during generation must not shrink the window.
  watchdog.markMeaningfulProgress();
  assert.equal(timers.last().delayMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);

  const windowIndex = timers.entries.length - 1;
  assert.equal(fired.length, 0);
  timers.fire(windowIndex);
  assert.deepEqual(fired, ['content-inactivity']);
});

test('multiple image items keep the long window until the last one finishes', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: string[] = [];
  const watchdog = createStreamingAttemptWatchdog({ onTimeout: (_error, kind) => fired.push(kind) });

  watchdog.beginImageGeneration('ig_a');
  watchdog.beginImageGeneration('ig_b');
  watchdog.endImageGeneration('ig_a');
  assert.equal(timers.last().delayMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);

  watchdog.endImageGeneration('ig_b');
  assert.equal(timers.last().delayMs, DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS);

  // Ending an item that was never active is a no-op rather than an extension.
  const before = timers.entries.length;
  watchdog.endImageGeneration('ig_unknown');
  assert.equal(timers.entries.length, before);
  assert.equal(fired.length, 0);
});

test('a hard deadline still wins while image generation is active', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: string[] = [];
  const watchdog = createStreamingAttemptWatchdog({
    hardTimeoutMs: 120_000,
    onTimeout: (_error, kind) => fired.push(kind),
  });

  watchdog.beginImageGeneration('ig_hard');
  timers.fire(1); // the hard deadline timer
  assert.deepEqual(fired, ['hard-deadline']);

  // After the deadline fires, later activity cannot revive the attempt.
  const countAfterDeadline = timers.entries.length;
  watchdog.markMeaningfulProgress();
  watchdog.beginImageGeneration('ig_late');
  assert.equal(timers.entries.length, countAfterDeadline);
});

test('finish clears every pending timer regardless of image state', () => {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const fired: string[] = [];
  const watchdog = createStreamingAttemptWatchdog({ onTimeout: (_error, kind) => fired.push(kind) });

  watchdog.beginImageGeneration('ig_finish');
  const windowIndex = timers.entries.length - 1;
  watchdog.finish();
  assert.equal(timers.entries[windowIndex].cleared, true);
  timers.fire(windowIndex);
  assert.deepEqual(fired, []);
});
