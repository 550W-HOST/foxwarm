import assert from 'node:assert/strict';
import test from 'node:test';
import * as firefox from '../background/firefox.js';
const signal = () => new AbortController().signal;
test('Firefox binds injections to the admitted document and propagates frame errors without replay', async () => {
  const frame = { documentId: 'owned-document', url: 'https://example.org/' };
  const injections = [];
  globalThis.chrome = {
    webNavigation: { getFrame: async () => frame },
    scripting: { executeScript: async options => {
      injections.push(options);
      return [{ frameId: 0, documentId: frame.documentId, error: { message: 'Element reference is stale.' } }];
    } },
  };
  const expected = await firefox.page(1, signal());
  await assert.rejects(firefox.content(1, expected, 'snapshot', signal()), /reference is stale/);
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].target, { tabId: 1, documentIds: ['owned-document'] });
  frame.documentId = 'reloaded-document';
  await assert.rejects(firefox.content(1, expected, 'snapshot', signal()), /Page changed/);
  assert.equal(injections.length, 1, 'Stale document never reaches injection');
  const fresh = await firefox.page(1, signal());
  firefox.invalidate(1);
  await assert.rejects(firefox.assertPage(1, fresh, signal()), /Page changed/);
});
test('Firefox requires current optional JavaScript permission and does not emulate editing keys', async () => {
  let evaluations = 0;
  globalThis.chrome = {
    permissions: { contains: async () => false },
    userScripts: { execute: async () => { evaluations++; } },
  };
  await assert.rejects(firefox.action(1, {}, 'execute_js', { code: '1' }, signal()), /Allow page JavaScript/);
  await assert.rejects(firefox.action(1, {}, 'press_key', { key: 'Enter' }, signal()), /not supported/);
  assert.equal(evaluations, 0);
});
test('Firefox fences a canceled injection and never retries its effect', async () => {
  const frame = { documentId: 'cancel-document', url: 'https://example.org/' };
  let complete, started, calls = 0;
  const injected = new Promise(resolve => { started = resolve; });
  globalThis.chrome = {
    webNavigation: { getFrame: async () => frame },
    scripting: { executeScript: () => {
      calls++; started(); return new Promise(resolve => { complete = resolve; });
    } },
  };
  const controller = new AbortController();
  const expected = await firefox.page(2, controller.signal);
  const result = firefox.content(2, expected, 'text', controller.signal);
  await injected; controller.abort(new Error('Session canceled'));
  await assert.rejects(result, /Session canceled/);
  complete([{ frameId: 0, documentId: frame.documentId, result: { text: 'LATE-PRIVATE' } }]);
  assert.equal(calls, 1);
});
