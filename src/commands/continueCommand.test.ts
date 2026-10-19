import '../testEnvironment';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelContext } from '../channel';
import { COMMANDS } from '../commands';
import * as sessionRuntime from '../sessionRuntime';
import type { Message } from '../types';
import { parseSessionControlFeedback } from '../../packages/shared/dist/sessionControlFeedback';

type Reply = { text: string; feedback: ReturnType<typeof parseSessionControlFeedback> };

function makeContext(replies: Reply[], channelType: string): ChannelContext {
  return {
    platform: channelType, channelId: channelType, channelType,
    channelUserId: 'room', conversationId: 'room', username: 'user', senderId: 'user',
    reply: async (text, options) => { replies.push({ text, feedback: parseSessionControlFeedback(options?.sessionControlFeedback) }); },
    sendTyping: async () => {},
  } as ChannelContext;
}

function historyDto(messages: Message[], state: 'idle' | 'waiting' | 'requesting-model' = 'idle'): any {
  return {
    session: {
      id: 'fixture/main',
      busy: state === 'requesting-model',
      runtimeState: { state, busy: state === 'requesting-model', queueLength: 0 },
    },
    messages,
    queue: [],
    persistentMemorySnapshot: '',
  };
}

for (const channelType of ['webui', 'telegram']) {
  test(`/continue routes local admission through the internal retry control and removes /retry (${channelType})`, async () => {
    const originalGetSession = sessionRuntime.getSession;
    const originalControl = sessionRuntime.control;
    const replies: Reply[] = [];
    const controls: Array<{ sessionId: string; action: string }> = [];
    try {
      (sessionRuntime as any).getSession = async () => historyDto([], 'idle').session;
      (sessionRuntime as any).control = async (sessionId: string, action: string) => {
        assert.equal(replies.length, 1, 'acknowledgement precedes awaiting the resumed run');
        controls.push({ sessionId, action });
        return { action };
      };

      assert.equal(COMMANDS['/retry'], undefined);
      assert.ok(COMMANDS['/continue']);
      await COMMANDS['/continue'].handler(makeContext(replies, channelType), [], 'fixture/main', { id: 'fixture/main' } as any);

      assert.deepEqual(controls, [{ sessionId: 'fixture/main', action: 'retry' }]);
      if (channelType === 'webui') {
        assert.deepEqual(replies.map(reply => [reply.feedback?.action, reply.feedback?.status]), [['continue', 'accepted']]);
      } else {
        assert.deepEqual(replies, [{ text: '▶️ Continuing interrupted turn...', feedback: null }]);
      }
    } finally {
      (sessionRuntime as any).getSession = originalGetSession;
      (sessionRuntime as any).control = originalControl;
    }
  });

  test(`/continue reports exact-owner completed rejection and suppresses waiting admission (${channelType})`, async () => {
    const originalGetSession = sessionRuntime.getSession;
    const originalControl = sessionRuntime.control;
    const replies: Reply[] = [];
    let controls = 0;
    try {
      (sessionRuntime as any).getSession = async () => historyDto([], 'idle').session;
      (sessionRuntime as any).control = async () => {
        controls += 1;
        const error: any = new Error('Session has no interrupted turn to continue.');
        error.code = 'SESSION_CONTINUATION_NOT_AVAILABLE';
        throw error;
      };
      await COMMANDS['/continue'].handler(makeContext(replies, channelType), [], 'fixture/main', { id: 'fixture/main' } as any);

      (sessionRuntime as any).getSession = async () => historyDto([], 'waiting').session;
      await COMMANDS['/continue'].handler(makeContext(replies, channelType), [], 'fixture/main', { id: 'fixture/main' } as any);

      assert.equal(controls, 1);
      if (channelType === 'webui') {
        assert.deepEqual(replies.map(reply => [reply.feedback?.action, reply.feedback?.status]), [
          ['continue', 'accepted'], ['continue', 'noop'], ['continue', 'noop'],
        ]);
        assert.equal(replies[1].feedback?.details, 'Session has no interrupted turn to continue.');
        assert.match(replies[2].feedback?.message || '', /waiting/i);
      } else {
        assert.deepEqual(replies.map(reply => reply.text), [
          '▶️ Continuing interrupted turn...',
          '⚠️ Session has no interrupted turn to continue.',
          '⚠️ Session is waiting and cannot be continued manually.',
        ]);
        assert.ok(replies.every(reply => reply.feedback === null));
      }
    } finally {
      (sessionRuntime as any).getSession = originalGetSession;
      (sessionRuntime as any).control = originalControl;
    }
  });

  test(`/continue describes a lost Worker response as unknown without calling it a definite failure (${channelType})`, async () => {
    const originalGetSession = sessionRuntime.getSession;
    const originalControl = sessionRuntime.control;
    const replies: Reply[] = [];
    let controls = 0;
    try {
      (sessionRuntime as any).getSession = async () => historyDto([], 'idle').session;
      (sessionRuntime as any).control = async () => {
        controls++;
        const error: any = new Error('response lost');
        error.code = 'SESSION_WORKER_RETRY_OUTCOME_UNKNOWN';
        throw error;
      };
      await COMMANDS['/continue'].handler(makeContext(replies, channelType), [], 'fixture/main', { id: 'fixture/main' } as any);

      assert.equal(controls, 1, 'an ambiguous response must not automatically repeat the control');
      if (channelType === 'webui') {
        assert.deepEqual(replies.map(reply => [reply.feedback?.action, reply.feedback?.status]), [
          ['continue', 'accepted'], ['continue', 'error'],
        ]);
        assert.match(replies[1].feedback?.message || '', /outcome unknown/i);
        assert.match(replies[1].feedback?.details || '', /inspect session history/i);
      } else {
        assert.deepEqual(replies.map(reply => reply.text), [
          '▶️ Continuing interrupted turn...',
          '⚠️ Continue outcome is unknown: it may already be committed or delivered. Inspect session history before continuing again.',
        ]);
        assert.ok(replies.every(reply => reply.feedback === null));
      }
      assert.equal(replies.some(reply => reply.text.startsWith('❌ Continue failed:')), false);
    } finally {
      (sessionRuntime as any).getSession = originalGetSession;
      (sessionRuntime as any).control = originalControl;
    }
  });
}
