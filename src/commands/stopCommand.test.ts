import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelContext } from '../channel';
import { COMMANDS } from '../commands';
import * as sessionRuntime from '../sessionRuntime';
import { parseSessionControlFeedback } from '../../packages/shared/dist/sessionControlFeedback';

type Reply = { text: string; feedback: ReturnType<typeof parseSessionControlFeedback> };

function context(replies: Reply[], channelType: string): ChannelContext {
  return {
    platform: channelType, channelId: channelType, channelType, channelUserId: 'room',
    conversationId: 'room', username: 'user', senderId: 'user',
    reply: async (text, options) => { replies.push({ text, feedback: parseSessionControlFeedback(options?.sessionControlFeedback) }); },
    sendTyping: async () => {},
  } as ChannelContext;
}

const session = { id: 'fixture/main' } as any;

for (const channelType of ['webui', 'telegram']) {
  test(`/stop compact has dedicated autocomplete and never invokes ordinary Stop (${channelType})`, async () => {
    const originalCancel = sessionRuntime.cancelCompaction;
    const originalControl = sessionRuntime.control;
    const replies: Reply[] = [];
    let controls = 0;
    try {
      (sessionRuntime as any).cancelCompaction = async () => ({ outcome: 'cancelled', phase: 'planning' });
      (sessionRuntime as any).control = async () => { controls += 1; return { action: 'stop' }; };
      assert.equal(COMMANDS['/stop'].autocomplete?.children?.[0]?.value, 'compact');
      await COMMANDS['/stop'].handler(context(replies, channelType), ['compact'], session.id, session);
      assert.equal(controls, 0);
      if (channelType === 'webui') {
        assert.deepEqual(replies.map(reply => [reply.feedback?.action, reply.feedback?.status]), [['cancel-compaction', 'accepted']]);
      } else {
        assert.deepEqual(replies, [{ text: '🛑 Compaction cancelled. The current Session run was not stopped.', feedback: null }]);
      }
    } finally {
      (sessionRuntime as any).cancelCompaction = originalCancel;
      (sessionRuntime as any).control = originalControl;
    }
  });

  test(`/stop compact reports no-op and too-late outcomes, while unknown stop arguments are rejected (${channelType})`, async () => {
    const originalCancel = sessionRuntime.cancelCompaction;
    const originalControl = sessionRuntime.control;
    const replies: Reply[] = [];
    let cancellations = 0;
    let controls = 0;
    try {
      let outcome: 'none' | 'completed' = 'none';
      (sessionRuntime as any).cancelCompaction = async () => { cancellations++; return { outcome }; };
      (sessionRuntime as any).control = async () => { controls++; return { action: 'stop' }; };
      await COMMANDS['/stop'].handler(context(replies, channelType), ['compact'], session.id, session);
      outcome = 'completed';
      await COMMANDS['/stop'].handler(context(replies, channelType), ['compact'], session.id, session);
      await COMMANDS['/stop'].handler(context(replies, channelType), ['other'], session.id, session);
      assert.equal(cancellations, 2, 'unknown arguments must not cancel compaction');
      assert.equal(controls, 0);
      if (channelType === 'webui') {
        assert.deepEqual(replies.slice(0, 2).map(reply => [reply.feedback?.action, reply.feedback?.status]), [
          ['cancel-compaction', 'noop'], ['cancel-compaction', 'noop'],
        ]);
        assert.match(replies[0].feedback?.message || '', /no active compaction/i);
        assert.match(replies[1].feedback?.message || '', /already applied/i);
      } else {
        assert.deepEqual(replies.slice(0, 2).map(reply => reply.text), [
          '⚠️ No active compaction to cancel.',
          '⚠️ Compaction had already committed; cancellation was too late.',
        ]);
        assert.ok(replies.every(reply => reply.feedback === null));
      }
      assert.equal(replies[2].text, 'Usage: `/stop` or `/stop compact`');
    } finally {
      (sessionRuntime as any).cancelCompaction = originalCancel;
      (sessionRuntime as any).control = originalControl;
    }
  });

  test(`ordinary /stop preserves compact-only standalone work and reports no main run stopped (${channelType})`, async () => {
    const originalGet = sessionRuntime.getSession;
    const originalControl = sessionRuntime.control;
    const originalCancel = sessionRuntime.cancelCompaction;
    const replies: Reply[] = [];
    const controls: string[] = [];
    let cancellations = 0;
    try {
      (sessionRuntime as any).getSession = async () => ({ busy: true, queueLength: 1 });
      (sessionRuntime as any).control = async (_id: string, action: string) => {
        controls.push(action);
        return { action: 'stop', stoppedCurrent: false, abortedInFlight: false };
      };
      (sessionRuntime as any).cancelCompaction = async () => { cancellations++; return { outcome: 'cancelled' }; };
      await COMMANDS['/stop'].handler(context(replies, channelType), [], session.id, session);
      assert.deepEqual(controls, ['stop']);
      assert.equal(cancellations, 0);
      if (channelType === 'webui') {
        assert.deepEqual(replies.map(reply => [reply.feedback?.action, reply.feedback?.status]), [['stop', 'noop']]);
      } else {
        assert.deepEqual(replies, [{ text: '⚠️ No main Session run was stopped. Compaction continues; use `/stop compact` to cancel it.', feedback: null }]);
      }
    } finally {
      (sessionRuntime as any).getSession = originalGet;
      (sessionRuntime as any).control = originalControl;
      (sessionRuntime as any).cancelCompaction = originalCancel;
    }
  });
}
