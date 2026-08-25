import test from 'node:test';
import assert from 'node:assert/strict';
import { definitions } from './definitions';
import { normalizeCreateChildSessionArgs, normalizeCreateSessionArgs, normalizeForceModel } from '../toolsSessionAgent/helpers';
import { resolveModelConfig } from '../config';

const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

test('model-facing creation schemas require intentional nested forceModel overrides', () => {
  const child = definitions.find(def => def.name === 'create_child_session')!;
  const create = definitions.find(def => def.name === 'create_session')!;
  const settings = definitions.find(def => def.name === 'set_session_child_model')!;
  for (const definition of [child, create]) {
    const properties = definition.parameters.properties as any;
    assert.equal(properties.model, undefined);
    assert.equal(properties.effort, undefined);
    assert.equal(properties.forceModel.type, 'object');
    assert.equal(properties.forceModel.additionalProperties, false);
    assert.equal(properties.forceModel.properties.modelId.type, 'string');
    assert.deepEqual(properties.forceModel.properties.effort.enum, efforts);
    assert.deepEqual(properties.forceModel.required, undefined);
  }
  assert.deepEqual((settings.parameters.properties as any).effort.enum, [...efforts, 'default', 'unset']);
  assert.equal((settings.parameters.properties as any).clearEffort, undefined);
});

test('forceModel parser is strict, non-mutating, and accepts all supported override combinations', () => {
  const modelId = resolveModelConfig(undefined).currentKey;
  const both = { forceModel: { modelId: ` ${modelId} `, effort: 'xhigh' } };
  assert.deepEqual(normalizeForceModel({}, 'create_session'), {});
  assert.deepEqual(normalizeForceModel({ forceModel: {} }, 'create_session'), {});
  assert.deepEqual(normalizeForceModel({ forceModel: { modelId } }, 'create_session'), { model: modelId });
  assert.deepEqual(normalizeForceModel({ forceModel: { effort: 'none' } }, 'create_child_session'), { effort: 'none' });
  assert.deepEqual(normalizeForceModel(both, 'create_child_session'), { model: modelId, effort: 'xhigh' });
  assert.deepEqual(both, { forceModel: { modelId: ` ${modelId} `, effort: 'xhigh' } });

  for (const forceModel of [null, [], 'model', 1] as unknown[]) {
    assert.throws(() => normalizeForceModel({ forceModel }, 'create_session'), /forceModel must be an object/);
  }
  assert.throws(() => normalizeForceModel({ forceModel: { extra: true } }, 'create_session'), /unknown key: extra/);
  assert.throws(() => normalizeForceModel({ forceModel: { modelId: '' } }, 'create_session'), /bounded non-empty string/);
  assert.throws(() => normalizeForceModel({ forceModel: { modelId: 'x'.repeat(4097) } }, 'create_session'), /bounded non-empty string/);
  assert.throws(() => normalizeForceModel({ forceModel: { effort: 'default' } }, 'create_session'), /must be one of/);
  assert.throws(() => normalizeForceModel({ model: modelId }, 'create_session'), /no longer accepts top-level model or effort/);
  assert.throws(() => normalizeForceModel({ effort: undefined }, 'create_child_session'), /no longer accepts top-level model or effort/);

  const childArgs = { suffix: 'child', forceModel: { effort: 'low' } };
  const sessionArgs = { agentName: 'main', sessionName: 'session', forceModel: {} };
  assert.deepEqual(normalizeCreateChildSessionArgs(childArgs), childArgs);
  assert.deepEqual(normalizeCreateSessionArgs(sessionArgs), sessionArgs);
  assert.notEqual(normalizeCreateChildSessionArgs(childArgs), childArgs);
  assert.notEqual(normalizeCreateChildSessionArgs(childArgs).forceModel, childArgs.forceModel);
  assert.throws(() => normalizeCreateChildSessionArgs({ suffix: 'child', bogus: true }), /unknown key: bogus/);
  assert.throws(() => normalizeCreateSessionArgs({ agentName: 'main', sessionName: 'session', bogus: true }), /unknown key: bogus/);
});
