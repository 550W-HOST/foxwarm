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
  pending() {
    return this.entries.filter(entry => !entry.cleared).at(-1);
  }
}

afterEach(() => setStreamingTimeoutTestHooks());

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
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
const LIFECYCLE = (itemId: string, index = 0) => ({
  type: 'response.image_generation_call.in_progress',
  output_index: index,
  item_id: itemId,
});

async function tick(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

type ScenarioResult = {
  timers: FakeTimers;
  fired: Array<{ kind: string; timeoutMs: number; message: string }>;
  outcome: string;
  pendingDelayMs?: number;
};

async function runScenario(options: {
  events: unknown[];
  holder?: (stream: PassThrough) => void;
  inactivityMs?: number;
  hardTimeoutMs?: number;
  fire?: 'pending' | 'hard-deadline';
}): Promise<ScenarioResult> {
  const timers = new FakeTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  const controller = new AbortController();
  const fired: Array<{ kind: string; timeoutMs: number; message: string }> = [];
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
    onImageGenerationStarted: () => watchdog.beginImageGeneration(),
  }).then(() => 'resolved', error => `rejected:${error?.code || error?.name || 'error'}`);
  for (const event of options.events) stream.write(sse(event));
  options.holder?.(stream);
  await tick();
  await tick();
  const pending = options.fire === 'hard-deadline'
    ? timers.entries.find(entry => !entry.cleared && entry.delayMs === options.hardTimeoutMs)
    : timers.pending();
  const pendingDelayMs = pending?.delayMs;
  pending?.callback();
  await tick();
  watchdog.finish();
  stream.destroy();
  return { timers, fired, outcome: await Promise.race([collected, tick().then(() => 'pending')]), pendingDelayMs };
}

test('an image item that finishes before the response keeps the extended inactivity window', async () => {
  // The stream shape that must keep waiting: the image item completes, then the
  // response stays silent instead of sending response.completed.
  const result = await runScenario({
    events: [
      { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
      OUTPUT_ITEM_ADDED('ig_first'),
      LIFECYCLE('ig_first'),
      OUTPUT_ITEM_DONE('ig_first'),
    ],
  });
  assert.equal(result.pendingDelayMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].kind, 'content-inactivity');
  assert.equal(result.fired[0].timeoutMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  assert.equal(result.outcome, 'rejected:ERR_CANCELED');
});

test('an image item that never reports completion also keeps the extended window', async () => {
  const result = await runScenario({
    events: [OUTPUT_ITEM_ADDED('ig_open'), LIFECYCLE('ig_open')],
  });
  assert.equal(result.pendingDelayMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
  assert.equal(result.fired[0].timeoutMs, IMAGE_GENERATION_CONTENT_INACTIVITY_TIMEOUT_MS);
});

test('a response without any image call still times out at the configured inactivity', async () => {
  const result = await runScenario({
    events: [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
    ],
  });
  assert.equal(result.pendingDelayMs, CONFIGURED_INACTIVITY_MS);
  assert.equal(result.fired[0].timeoutMs, CONFIGURED_INACTIVITY_MS);
  assert.match(result.fired[0].message, /further model output activity after 180000ms/);
});

test('the explicit hard deadline still ends an attempt that started an image', async () => {
  const result = await runScenario({
    events: [OUTPUT_ITEM_ADDED('ig_hard')],
    hardTimeoutMs: 120_000,
    fire: 'hard-deadline',
  });
  assert.equal(result.fired.length, 1);
  assert.equal(result.fired[0].kind, 'hard-deadline');
  assert.equal(result.fired[0].timeoutMs, 120_000);
});
