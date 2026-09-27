import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  createStreamingAttemptWatchdog,
  IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS,
  setStreamingTimeoutTestHooks,
} from './llmStreamingTimeout';
import { collectOpenAIResponsesStream } from './llmProviders/openai';

// A short configured provider inactivity window (180 s): a hosted image
// response that reports its image and then stays silent must keep the extended
// allowance instead of being cut off at this value.
const CONFIGURED_INACTIVITY_MS = 180_000;

class FakeClock {
  private current = 0;
  entries: Array<{ callback: () => void; delayMs: number; dueAt: number; cleared: boolean; timer: any }> = [];
  hooks = {
    set: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, dueAt: this.current + delayMs, cleared: false, timer: undefined as any };
      entry.timer = { unref: () => {} };
      this.entries.push(entry);
      return entry.timer;
    },
    clear: (timer: any) => {
      const entry = this.entries.find(candidate => candidate.timer === timer);
      if (entry) entry.cleared = true;
    },
  };
  pending() {
    return this.entries
      .filter(entry => !entry.cleared)
      .sort((left, right) => left.dueAt - right.dueAt || this.entries.indexOf(left) - this.entries.indexOf(right))[0];
  }
  advance(ms: number) {
    const target = this.current + ms;
    for (;;) {
      const due = this.entries.filter(entry => !entry.cleared && entry.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!due) break;
      due.cleared = true;
      this.current = due.dueAt;
      due.callback();
    }
    this.current = target;
  }
}

afterEach(() => setStreamingTimeoutTestHooks());

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function tick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

const OUTPUT_ITEM_ADDED = (itemId: string, index = 0) => ({
  type: 'response.output_item.added',
  output_index: index,
  item: { type: 'image_generation_call', id: itemId, status: 'in_progress' },
});
const OUTPUT_ITEM_DONE = (itemId: string, index = 0) => ({
  type: 'response.output_item.done',
  output_index: index,
  item: { type: 'image_generation_call', id: itemId, status: 'completed', output_format: 'png', result: 'iVBORw0KGgo=' },
});
const LIFECYCLE = (state: string, itemId: string, index = 0) => ({
  type: `response.image_generation_call.${state}`,
  output_index: index,
  item_id: itemId,
});

type FiredTimeout = { kind: string; timeoutMs: number; message: string };

function startScenario(options: { inactivityMs?: number; hardTimeoutMs?: number } = {}) {
  const clock = new FakeClock();
  setStreamingTimeoutTestHooks(clock.hooks);
  const controller = new AbortController();
  const fired: FiredTimeout[] = [];
  const watchdog = createStreamingAttemptWatchdog({
    hardTimeoutMs: options.hardTimeoutMs,
    streamContentInactivityTimeoutMs: options.inactivityMs ?? CONFIGURED_INACTIVITY_MS,
    onTimeout: (error, kind) => {
      fired.push({ kind, timeoutMs: Number(/(\d+)ms\./.exec(error.message)?.[1]), message: error.message });
      controller.abort();
    },
  });
  const stream = new PassThrough();
  const collected = collectOpenAIResponsesStream(stream, controller.signal, {
    onMeaningfulProgress: () => watchdog.markMeaningfulProgress(),
    onImageGenerationActivity: () => watchdog.reportImageGenerationActivity(),
  }).then(() => 'resolved', error => `rejected:${error?.code || error?.name || 'error'}`);
  return {
    clock,
    fired,
    async write(events: unknown[]) {
      for (const event of events) stream.write(sse(event));
      await tick();
      await tick();
    },
    async advance(ms: number) {
      clock.advance(ms);
      await tick();
    },
    pendingDelay() {
      return clock.pending()?.delayMs;
    },
    async finish() {
      watchdog.finish();
      stream.destroy();
      return Promise.race([collected, tick().then(() => 'pending')]);
    },
  };
}

test('an image item that finishes before the response keeps the extended inactivity window', async () => {
  // The stream shape that must keep waiting: the image item completes, then the
  // response stays silent instead of sending response.completed.
  const scenario = startScenario();
  await scenario.write([
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    OUTPUT_ITEM_ADDED('ig_first'),
    LIFECYCLE('in_progress', 'ig_first'),
    OUTPUT_ITEM_DONE('ig_first'),
  ]);
  assert.equal(scenario.pendingDelay(), IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  await scenario.advance(IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  assert.equal(scenario.fired.length, 1);
  assert.equal(scenario.fired[0].kind, 'content-inactivity');
  assert.equal(scenario.fired[0].timeoutMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  assert.equal(await scenario.finish(), 'rejected:ERR_CANCELED');
});

test('an image item that never reports completion also keeps the extended window', async () => {
  const scenario = startScenario();
  await scenario.write([OUTPUT_ITEM_ADDED('ig_open'), LIFECYCLE('in_progress', 'ig_open')]);
  assert.equal(scenario.pendingDelay(), IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  await scenario.advance(IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  assert.equal(scenario.fired[0].timeoutMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  await scenario.finish();
});

test('every image activity restarts the extended window instead of forming a per-attempt cap', async () => {
  const scenario = startScenario();
  await scenario.write([OUTPUT_ITEM_ADDED('ig_activity'), LIFECYCLE('in_progress', 'ig_activity')]);
  const firstWindow = scenario.clock.pending();
  assert.equal(firstWindow?.delayMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);

  // Almost the whole window passes without another provider event.
  await scenario.advance(IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS - 1_000);
  assert.deepEqual(scenario.fired, []);

  // Generating and defensive partial-preview statuses are ongoing progress.
  await scenario.write([
    LIFECYCLE('generating', 'ig_activity'),
    LIFECYCLE('partial_image', 'ig_activity'),
  ]);
  assert.equal(firstWindow?.cleared, true, 'a later image activity must replace the previous window');
  assert.equal(scenario.pendingDelay(), IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);

  // The restarted window is full again: the old deadline would already have passed.
  await scenario.advance(IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS - 1_000);
  assert.deepEqual(scenario.fired, []);

  // A completion status is generation progress too, even without response.completed.
  const windowBeforeCompletion = scenario.clock.pending();
  await scenario.write([LIFECYCLE('completed', 'ig_activity')]);
  assert.equal(windowBeforeCompletion?.cleared, true);
  assert.equal(scenario.pendingDelay(), IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);

  // Only silence after the last activity ends the attempt, at the extended value.
  await scenario.advance(IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  assert.equal(scenario.fired.length, 1);
  assert.equal(scenario.fired[0].kind, 'content-inactivity');
  assert.equal(scenario.fired[0].timeoutMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  await scenario.finish();
});

test('a response without any image call still times out at the configured inactivity', async () => {
  const scenario = startScenario();
  await scenario.write([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
  ]);
  assert.equal(scenario.pendingDelay(), CONFIGURED_INACTIVITY_MS);
  await scenario.advance(CONFIGURED_INACTIVITY_MS);
  assert.equal(scenario.fired.length, 1);
  assert.equal(scenario.fired[0].timeoutMs, CONFIGURED_INACTIVITY_MS);
  assert.match(scenario.fired[0].message, /further model output activity after 180000ms/);
  await scenario.finish();
});

test('the explicit hard deadline still ends an attempt that reported image activity', async () => {
  const scenario = startScenario({ hardTimeoutMs: 120_000 });
  await scenario.write([OUTPUT_ITEM_ADDED('ig_hard')]);
  await scenario.advance(120_000);
  assert.equal(scenario.fired.length, 1);
  assert.equal(scenario.fired[0].kind, 'hard-deadline');
  assert.equal(scenario.fired[0].timeoutMs, 120_000);
  await scenario.finish();
});
