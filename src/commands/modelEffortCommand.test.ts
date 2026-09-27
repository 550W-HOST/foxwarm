import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../commands';
import { handleSessionCommand, parseSessionCreateFlags } from './sessionCmd';
import * as sessionManager from '../sessionManager';

function id(prefix: string) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

test('session create flags use one strict serial parser', () => {
  assert.deepEqual(parseSessionCreateFlags([
    '--system-prompt-file', 'one.md',
    '--model', 'provider/model/name',
    '--system-prompt-file', 'two.md',
    '--effort', 'xhigh',
  ]), { model: 'provider/model/name', effort: 'xhigh', systemPromptFiles: ['one.md', 'two.md'] });
  assert.deepEqual(parseSessionCreateFlags(['extra']), { error: 'Unknown /session create argument: extra' });
  assert.deepEqual(parseSessionCreateFlags(['--model', 'a', '--model', 'b']), { error: '--model may be specified only once.' });
  assert.deepEqual(parseSessionCreateFlags(['--effort', 'low', '--effort', 'high']), { error: '--effort may be specified only once.' });
  assert.deepEqual(parseSessionCreateFlags(['--model', '--effort', 'high']), { error: '--model requires a value.' });
  assert.deepEqual(parseSessionCreateFlags(['--model', '--unknown']), { error: '--model requires a value.' });
  assert.deepEqual(parseSessionCreateFlags(['--system-prompt-file']), { error: '--system-prompt-file requires a value.' });
});

test('model and child-model commands parse effort-only and atomic default clears', async () => {
  const sessionId = id('command_effort');
  const replies: string[] = [];
  const ctx: any = { reply: (text: string) => replies.push(text), channelId: 'test', conversationId: id('conversation') };
  try {
    const session = await sessionManager.getSession(sessionId);
    session.effort = 'high';
    session.childEffortDefault = 'low';
    await sessionManager.saveSession(sessionId);

    await COMMANDS['/model'].handler(ctx, [], sessionId, session as any);
    assert.match(replies.at(-1) || '', /\*Models\*/);

    await COMMANDS['/model'].handler(ctx, ['--effort', 'middle'], sessionId, session as any);
    assert.match(replies.at(-1) || '', /Effort must be one of/);
    assert.equal((await sessionManager.getSession(sessionId)).effort, 'high');

    await COMMANDS['/model'].handler(ctx, ['--effort', 'none'], sessionId, session as any);
    assert.equal((await sessionManager.getSession(sessionId)).effort, 'none');
    assert.match(replies.at(-1) || '', /raw=none, effective=none/);

    await COMMANDS['/model'].handler(ctx, ['default', '--effort', 'unset'], sessionId, session as any);
    const cleared = await sessionManager.getSession(sessionId);
    assert.equal(cleared.model, undefined);
    assert.equal(cleared.effort, undefined);

    await handleSessionCommand(ctx, ['child-model', '--effort', 'max'], sessionId, cleared as any);
    assert.equal((await sessionManager.getSession(sessionId)).childEffortDefault, 'max');
    await handleSessionCommand(ctx, ['child-model', 'default', '--effort', 'unset'], sessionId, cleared as any);
    const childCleared = await sessionManager.getSession(sessionId);
    assert.equal(childCleared.childModelDefault, undefined);
    assert.equal(childCleared.childEffortDefault, undefined);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('session create command accepts an explicit effort without requiring a model override', async () => {
  const sourceId = id('command_create_effort_source');
  const sessionName = id('command_create_effort_target');
  const conversationId = id('conversation');
  const replies: string[] = [];
  const ctx: any = { reply: (text: string) => replies.push(text), channelId: 'test', conversationId };
  try {
    const source = await sessionManager.getSession(sourceId);
    source.effort = 'low';
    await sessionManager.saveSession(sourceId);
    await handleSessionCommand(ctx, ['create', 'main', sessionName, '--effort', 'max'], sourceId, source as any);
    const created = await sessionManager.getSession(sessionName);
    assert.equal(created.effort, 'max');
    assert.match(replies.at(-1) || '', /Effort: max/);
  } finally {
    sessionManager.detachChannel('test', conversationId);
    await sessionManager.deleteSession(sessionName).catch(() => false);
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});

test('invalid session create flags fail before creating a session', async () => {
  const sourceId = id('command_create_invalid_source');
  const conversationId = id('conversation');
  const replies: string[] = [];
  const ctx: any = { reply: (text: string) => replies.push(text), channelId: 'test', conversationId };
  const invalidSuffixes = [
    ['unknown', '--unknown'],
    ['duplicate', '--effort', 'low', '--effort', 'high'],
    ['missing', '--model', '--effort', 'high'],
    ['positional', 'unexpected'],
  ];
  try {
    const source = await sessionManager.getSession(sourceId);
    for (const [suffix, ...flags] of invalidSuffixes) {
      const targetId = id(`command_create_invalid_${suffix}`);
      await handleSessionCommand(ctx, ['create', 'main', targetId, ...flags], sourceId, source as any);
      assert.equal(await sessionManager.getExistingSession(targetId), null);
      assert.match(replies.at(-1) || '', /Usage: \/session create/);
    }
  } finally {
    sessionManager.detachChannel('test', conversationId);
    await sessionManager.deleteSession(sourceId).catch(() => false);
  }
});
