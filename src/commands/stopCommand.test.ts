import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelContext } from '../channel';
import { COMMANDS } from '../commands';
import * as sessionRuntime from '../sessionRuntime';

function context(replies: string[]): ChannelContext {
  return {
    platform: 'webui', channelId: 'webui', channelType: 'webui', channelUserId: 'room',
    conversationId: 'room', username: 'user', senderId: 'user',
    reply: async (text: string) => { replies.push(text); }, sendTyping: async () => {},
  } as ChannelContext;
}

const session = { id: 'fixture/main' } as any;

test('/stop compact has dedicated autocomplete and never invokes ordinary Stop', async () => {
  const originalCancel = sessionRuntime.cancelCompaction;
  const originalControl = sessionRuntime.control;
  const replies: string[] = [];
  let controls = 0;
  try {
    (sessionRuntime as any).cancelCompaction = async () => ({ outcome: 'cancelled', phase: 'planning' });
    (sessionRuntime as any).control = async () => { controls += 1; return { action: 'stop' }; };
    assert.equal(COMMANDS['/stop'].autocomplete?.children?.[0]?.value, 'compact');
    await COMMANDS['/stop'].handler(context(replies), ['compact'], session.id, session);
    assert.equal(controls, 0);
    assert.deepEqual(replies, ['🛑 Compaction cancelled. The current Session run was not stopped.']);
  } finally {
    (sessionRuntime as any).cancelCompaction = originalCancel;
    (sessionRuntime as any).control = originalControl;
  }
});

test('/stop compact reports no-op and too-late outcomes, while unknown stop arguments are rejected', async () => {
  const originalCancel = sessionRuntime.cancelCompaction;
  const replies: string[] = [];
  try {
    let outcome: 'none' | 'completed' = 'none';
    (sessionRuntime as any).cancelCompaction = async () => ({ outcome });
    await COMMANDS['/stop'].handler(context(replies), ['compact'], session.id, session);
    outcome = 'completed';
    await COMMANDS['/stop'].handler(context(replies), ['compact'], session.id, session);
    await COMMANDS['/stop'].handler(context(replies), ['other'], session.id, session);
    assert.deepEqual(replies, [
      '⚠️ No active compaction to cancel.',
      '⚠️ Compaction had already committed; cancellation was too late.',
      'Usage: `/stop` or `/stop compact`',
    ]);
  } finally { (sessionRuntime as any).cancelCompaction = originalCancel; }
});

test('ordinary /stop preserves compact-only standalone work and reports no main run stopped', async () => {
  const originalGet = sessionRuntime.getSession;
  const originalControl = sessionRuntime.control;
  const replies: string[] = [];
  try {
    (sessionRuntime as any).getSession = async () => ({ busy: true, queueLength: 1 });
    (sessionRuntime as any).control = async () => ({ action: 'stop', stoppedCurrent: false, abortedInFlight: false });
    await COMMANDS['/stop'].handler(context(replies), [], session.id, session);
    assert.deepEqual(replies, ['⚠️ No main Session run was stopped. Compaction continues; use `/stop compact` to cancel it.']);
  } finally {
    (sessionRuntime as any).getSession = originalGet;
    (sessionRuntime as any).control = originalControl;
  }
});
