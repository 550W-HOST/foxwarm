import './testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import axios from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import * as config from './config';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import { LocalSessionTurnHost, SessionTurnRunner } from './sessionTurnRunner';
import { readSessionHistorySnapshot } from './session/metadataStore';
import { parseFoxwarmOpeningTag } from './utils/promptWrappers';
import type { Message } from './types';

const modelsFile = config.getActiveModelsConfigPath();
const fixtureModels = (defaultModel = 'fixture/a', ids = ['a', 'b', 'c']) => ({
  default: 'master', providers: {
    fixture: { providerType: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1', apiKey: 'synthetic',
      models: ids.map(id => ({ id, effort: id === 'a' ? { allowed: ['none', 'high'], default: 'high' }
        : { allowed: ['none', 'low'], default: 'none' } })) },
    master: defaultModel,
  },
});
function notices(history: Message[]) {
  return history.flatMap(message => message.parts)
    .filter(part => part.system?.includes('kind="session-settings-changed"'))
    .map(part => parseFoxwarmOpeningTag(part.system)!.attrs);
}

async function fixture(label: string) {
  await fs.ensureDir(path.dirname(modelsFile));
  await fs.writeJson(modelsFile, fixtureModels());
  const session = await sessionManager.getSession(`effective_selection_${Date.now()}_${label}`);
  const originalPost = axios.post;
  const requests: any[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    requests.push(body);
    return { status: 200, statusText: 'OK', headers: {}, data: Readable.from([
      'data: {"choices":[{"delta":{"content":"fixture answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]) };
  };
  sessionManager.setSessionTriggerCallback(() => {});
  const runner = new SessionTurnRunner(new LocalSessionTurnHost());
  return { session, requests,
    async run(text: string) {
      await sessionManager.enqueueSessionItem(session.id, { type: 'user', parts: [{ text }] });
      await runner.processSessionQueue(session.id);
      assert.equal(session.busy, false);
      assert.equal(session.queue.length, 0);
    },
    async close() {
      (axios as any).post = originalPost;
      await sessionManager.deleteSession(session.id);
      await fs.remove(modelsFile);
    },
  };
}

test('Main adopts concrete selections only at a real step, coalesces setters and ignores snapshot-marker refreshes', async () => {
  const f = await fixture('coalesce');
  try {
    await sessionRuntime.updateSettings(f.session.id, { model: 'master' });
    await f.run('first step');
    assert.deepEqual(notices(f.session.history), [], 'an unknown previous effective selection is initialized silently');
    assert.equal(f.session.meta.lastEffectiveRequest?.modelId, 'fixture/a');
    assert.equal(f.session.meta.lastEffectiveRequest?.effort, 'high');

    await sessionRuntime.updateSettings(f.session.id, { model: 'fixture/a' });
    await f.run('same concrete leaf alias');
    assert.equal(notices(f.session.history).length, 0);
    await sessionRuntime.updateSettings(f.session.id, { model: 'fixture/b' });
    await sessionRuntime.refreshSnapshot(f.session.id);
    assert.equal(f.session.meta.lastEffectiveRequest?.modelId, 'fixture/a', 'snapshot refresh is not a request');
    await sessionRuntime.updateSettings(f.session.id, { model: 'master' });
    await f.run('A to B to A without a step');
    assert.equal(notices(f.session.history).length, 0);

    await sessionRuntime.updateSettings(f.session.id, { model: 'fixture/c', currentNode: 'node-intermediate' });
    await sessionRuntime.updateSettings(f.session.id, { model: 'fixture/b', currentNode: 'node-final' });
    assert.equal(f.session.queue.length, 0);
    await f.run('one actual change');
    let changes = notices(f.session.history);
    assert.equal(changes.length, 1);
    assert.deepEqual([changes[0].oldModel, changes[0].newModel, changes[0].oldEffort, changes[0].newEffort],
      ['fixture/a', 'fixture/b', 'high', 'none']);
    assert.deepEqual([changes[0].oldNode, changes[0].newNode], ['master', 'node-final']);
    assert.equal(JSON.stringify(changes).includes('actor'), false);
    assert.equal(JSON.stringify(f.requests[3]).split('session-settings-changed').length - 1, 1);
    assert.deepEqual(f.requests.map(body => [body.model, body.reasoning_effort]), [
      ['a', 'high'], ['a', 'high'], ['a', 'high'], ['b', 'none'],
    ]);

    await sessionRuntime.updateSettings(f.session.id, { effort: 'low' });
    await f.run('effort only');
    assert.equal(notices(f.session.history).length, 1);
    await sessionRuntime.updateSettings(f.session.id, { currentNode: 'node-next' });
    await f.run('node next step');
    changes = notices(f.session.history);
    assert.equal(changes.length, 2);
    assert.equal(changes[1].oldModel, undefined);
    assert.deepEqual([changes[1].oldNode, changes[1].newNode, changes[1].effectiveEffort], ['node-final', 'node-next', 'low']);
    const durable = await readSessionHistorySnapshot(f.session.id);
    assert.deepEqual(durable.meta.lastEffectiveRequest, { modelId: 'fixture/b', nodeId: 'node-next', effort: 'low' });
  } finally { await f.close(); }
});

test('a deleted Session model falls back at execution and does not repeat the same effective fallback', async () => {
  const f = await fixture('missing');
  try {
    await sessionRuntime.updateSettings(f.session.id, { model: 'fixture/a' });
    await fs.writeJson(modelsFile, fixtureModels('fixture/b', ['b', 'c']));
    await f.run('first step after config deletion');
    let changes = notices(f.session.history);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].reason, 'missing-model');
    assert.equal(changes[0].requestedModel, 'fixture/a');
    assert.equal(changes[0].fallback, 'global-default');
    assert.equal(changes[0].modelId, 'fixture/b');
    assert.equal(changes[0].oldModel, undefined);
    assert.equal(changes[0].oldNode, undefined);
    assert.equal(changes[0].effectiveEffort, 'none');
    assert.match(JSON.stringify(f.requests[0]), /requestedModel=\\?"fixture\/a/);
    await f.run('same missing key');
    assert.equal(notices(f.session.history).length, 1);
    await fs.writeJson(modelsFile, fixtureModels('fixture/c', ['b', 'c']));
    await f.run('the actual default changed');
    changes = notices(f.session.history);
    assert.equal(changes.length, 2);
    assert.deepEqual([changes[1].oldModel, changes[1].newModel, changes[1].requestedModel], ['fixture/b', 'fixture/c', 'fixture/a']);
    assert.deepEqual(f.requests.map(body => body.model), ['b', 'b', 'c']);
    assert.equal(f.session.model, 'fixture/a', 'fallback does not silently rewrite raw Session policy');
  } finally { await f.close(); }
});
