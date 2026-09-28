import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelsConfigFromObject } from '../config';
import { buildSessionChildPolicyChain, buildSessionModelEffortPresentation } from './modelEffortPresentation';

const config = loadModelsConfigFromObject({
  default: 'a/one',
  providers: {
    a: { providerType: 'openai-responses', effort: { allowed: ['low', 'high'], default: 'high' }, models: ['one'] },
    b: { providerType: 'anthropic', effort: { allowed: ['medium', 'max'], default: 'medium' }, models: ['two'] },
    route: { providerType: 'failover', targets: ['a/one', 'b/two'] },
  },
});

test('model effort presentation exposes concrete defaults, virtual union, and tolerant stale fallback', () => {
  const concrete = buildSessionModelEffortPresentation({ model: 'a/one', effort: 'low' }, config);
  assert.deepEqual(concrete.effort, { raw: 'low', effective: 'low', allowed: ['low', 'high'], defaultEffort: 'high' });

  const stale = buildSessionModelEffortPresentation({ model: 'a/one', effort: 'max' }, config);
  assert.equal(stale.effort.raw, 'max');
  assert.equal(stale.effort.effective, 'high');

  const virtual = buildSessionModelEffortPresentation({ childModelDefault: 'route', childEffortDefault: 'medium' }, config);
  assert.deepEqual(virtual.childEffort.allowed, ['low', 'medium', 'high', 'max']);
  assert.equal(virtual.childEffort.defaultEffort, null);
  assert.equal(virtual.childEffort.effective, 'medium');
  const virtualUnset = buildSessionModelEffortPresentation({ model: 'route' }, config);
  assert.equal(virtualUnset.effort.raw, null);
  assert.equal(virtualUnset.effort.effective, 'default');
  assert.equal(virtualUnset.effort.defaultEffort, null);
  assert.equal(virtualUnset.childEffort.raw, null);
  assert.equal(virtualUnset.childEffort.effective, 'default');
  assert.equal(virtualUnset.childEffort.defaultEffort, null);
  assert.equal(buildSessionModelEffortPresentation({ model: 'a/one', effort: 'low' }, config).childEffort.effective, 'low');
});

test('child model policy source distinguishes a pinned policy from a follow policy', () => {
  const pinned = buildSessionModelEffortPresentation({ model: 'a/one', childModelDefault: 'b/two' }, config);
  assert.equal(pinned.childModelPolicySource, 'explicit');
  assert.equal(pinned.childModelDefault, 'b/two');
  assert.equal(pinned.effectiveChildModelKey, 'b/two');
  assert.deepEqual(pinned.childPolicyChain, [{
    level: 'session',
    sessionId: null,
    modelKey: 'a/one',
    effort: null,
    childModelDefault: 'b/two',
    childEffortDefault: null,
    source: 'explicit',
    supplies: true,
  }]);

  const follow = buildSessionModelEffortPresentation({ id: 's1', model: 'a/one' }, config);
  assert.equal(follow.childModelPolicySource, 'follow-parent');
  assert.equal(follow.effectiveChildModelKey, 'a/one');
  assert.deepEqual(follow.childPolicyChain, [{
    level: 'session',
    sessionId: 's1',
    modelKey: 'a/one',
    effort: null,
    childModelDefault: null,
    childEffortDefault: null,
    source: 'follow-parent',
    supplies: true,
  }]);
});

test('child policy chain walks ancestry and marks the hop that introduced the pin', () => {
  const ancestors: Record<string, any> = {
    root: { id: 'root', model: 'a/one', childModelDefault: 'b/two', childEffortDefault: 'max' },
    mid: { id: 'mid', model: 'b/two', childModelDefault: 'b/two', childEffortDefault: 'max', parentSessionId: 'root' },
  };
  const session = { id: 'leaf', model: 'b/two', childModelDefault: 'b/two', childEffortDefault: 'max' as const, parentSessionId: 'mid' };
  const view = buildSessionModelEffortPresentation(session, config, id => ancestors[id]);

  assert.equal(view.childModelPolicySource, 'explicit');
  assert.equal(view.effectiveChildModelKey, 'b/two');
  assert.deepEqual(view.childPolicyChain.map(chain => ({
    level: chain.level,
    sessionId: chain.sessionId,
    modelKey: chain.modelKey,
    childModelDefault: chain.childModelDefault,
    source: chain.source,
    supplies: chain.supplies,
  })), [
    { level: 'session', sessionId: 'leaf', modelKey: 'b/two', childModelDefault: 'b/two', source: 'inherited', supplies: false },
    { level: 'inherited', sessionId: 'mid', modelKey: 'b/two', childModelDefault: 'b/two', source: 'inherited', supplies: false },
    { level: 'inherited', sessionId: 'root', modelKey: 'a/one', childModelDefault: 'b/two', source: 'explicit', supplies: true },
  ]);

  // A hop that introduces its own (different) pin is the supplier, not the root.
  const override = buildSessionChildPolicyChain(
    { id: 'leaf', model: 'b/two', childModelDefault: 'a/one', parentSessionId: 'root' },
    id => ancestors[id],
  );
  assert.equal(override.length, 2);
  assert.equal(override[0].source, 'explicit');
  assert.equal(override[0].supplies, true);
  assert.equal(override[1].supplies, false);
});

test('child policy chain degrades to a single hop when ancestry is not reachable', () => {
  const unresolved = buildSessionModelEffortPresentation(
    { id: 'orphan', model: 'a/one', childModelDefault: 'b/two', parentSessionId: 'missing' },
    config,
    () => undefined,
  );
  assert.equal(unresolved.childPolicyChain.length, 1);
  assert.equal(unresolved.childPolicyChain[0].level, 'session');
  assert.equal(unresolved.childPolicyChain[0].childModelDefault, 'b/two');

  const noResolver = buildSessionModelEffortPresentation({ id: 'solo', model: 'a/one', parentSessionId: 'missing' }, config);
  assert.equal(noResolver.childPolicyChain.length, 1);
  assert.equal(noResolver.childPolicyChain[0].sessionId, 'solo');
});

test('child effort fallback still reports raw, effective, and allowed sets', () => {
  const stale = buildSessionModelEffortPresentation({ model: 'a/one', childModelDefault: 'b/two', childEffortDefault: 'low' }, config);
  assert.equal(stale.childEffort.raw, 'low');
  assert.equal(stale.childEffort.effective, 'medium');
  assert.deepEqual(stale.childEffort.allowed, ['medium', 'max']);
});
