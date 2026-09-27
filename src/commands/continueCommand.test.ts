import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelContext } from '../channel';
import { COMMANDS } from '../commands';
import * as sessionRuntime from '../sessionRuntime';
import type { Message } from '../types';

function makeContext(replies: string[]): ChannelContext {
  return {
    platform: 'webui', channelId: 'webui', channelType: 'webui',
    channelUserId: 'room', conversationId: 'room', username: 'user', senderId: 'user',
    reply: async (text: string) => { replies.push(text); },
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

test('/continue routes local admission through the internal retry control and removes /retry', async () => {
  const originalGetSession = sessionRuntime.getSession;
  const originalControl = sessionRuntime.control;
  const replies: string[] = [];
  const controls: Array<{ sessionId: string; action: string }> = [];
  try {
    (sessionRuntime as any).getSession = async () => historyDto([], 'idle').session;
    (sessionRuntime as any).control = async (sessionId: string, action: string) => {
      controls.push({ sessionId, action });
      return { action };
    };

    assert.equal(COMMANDS['/retry'], undefined);
    assert.ok(COMMANDS['/continue']);
    await COMMANDS['/continue'].handler(makeContext(replies), [], 'fixture/main', { id: 'fixture/main' } as any);

    assert.deepEqual(controls, [{ sessionId: 'fixture/main', action: 'retry' }]);
    assert.deepEqual(replies, ['▶️ Continuing interrupted turn...']);
  } finally {
    (sessionRuntime as any).getSession = originalGetSession;
    (sessionRuntime as any).control = originalControl;
  }
});

test('/continue reports exact-owner completed rejection and suppresses waiting admission', async () => {
  const originalGetSession = sessionRuntime.getSession;
  const originalControl = sessionRuntime.control;
  const replies: string[] = [];
  let controls = 0;
  try {
    (sessionRuntime as any).getSession = async () => historyDto([], 'idle').session;
    (sessionRuntime as any).control = async () => {
      controls += 1;
      const error: any = new Error('Session has no interrupted turn to continue.');
      error.code = 'SESSION_CONTINUATION_NOT_AVAILABLE';
      throw error;
    };
    await COMMANDS['/continue'].handler(makeContext(replies), [], 'fixture/main', { id: 'fixture/main' } as any);

    (sessionRuntime as any).getSession = async () => historyDto([], 'waiting').session;
    await COMMANDS['/continue'].handler(makeContext(replies), [], 'fixture/main', { id: 'fixture/main' } as any);

    assert.equal(controls, 1);
    assert.deepEqual(replies, [
      '▶️ Continuing interrupted turn...',
      '⚠️ Session has no interrupted turn to continue.',
      '⚠️ Session is waiting and cannot be continued manually.',
    ]);
  } finally {
    (sessionRuntime as any).getSession = originalGetSession;
    (sessionRuntime as any).control = originalControl;
  }
});

test('/continue describes a lost Worker response as unknown without calling it a definite failure', async () => {
  const originalGetSession = sessionRuntime.getSession;
  const originalControl = sessionRuntime.control;
  const replies: string[] = [];
  try {
    (sessionRuntime as any).getSession = async () => historyDto([], 'idle').session;
    (sessionRuntime as any).control = async () => {
      const error: any = new Error('response lost');
      error.code = 'SESSION_WORKER_RETRY_OUTCOME_UNKNOWN';
      throw error;
    };
    await COMMANDS['/continue'].handler(makeContext(replies), [], 'fixture/main', { id: 'fixture/main' } as any);

    assert.deepEqual(replies, [
      '▶️ Continuing interrupted turn...',
      '⚠️ Continue outcome is unknown: it may already be committed or delivered. Inspect session history before continuing again.',
    ]);
    assert.equal(replies.some(reply => reply.startsWith('❌ Continue failed:')), false);
  } finally {
    (sessionRuntime as any).getSession = originalGetSession;
    (sessionRuntime as any).control = originalControl;
  }
});
