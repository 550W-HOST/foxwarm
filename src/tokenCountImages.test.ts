import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateSessionSummary } from './tokenCount';
import { COMMANDS } from './commands';
import type { Session } from './types';
import type { ChannelContext } from './channel';

function createSession(history: Session['history']): Session {
  return {
    id: 'token_image_test',
    agent: 'main',
    history,
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
}

test('image inline data and image tool payloads do not inflate token estimates', () => {
  const bigImage = 'a'.repeat(200_000);
  const session = createSession([
    {
      role: 'user',
      parts: [
        { text: 'please inspect this image' },
        { inlineData: { mimeType: 'image/png', data: bigImage } },
      ],
    },
    {
      role: 'tool',
      parts: [
        {
          functionResponse: {
            tool_use_id: 'tool1',
            name: 'browse_get',
            response: {
              output: 'screenshot captured',
              inlineData: { mimeType: 'image/png', data: bigImage },
            },
          },
        },
      ],
    },
  ]);

  const summary = estimateSessionSummary(session);
  assert.equal(summary.imageCount, 2);
  assert(summary.tokens < 200, `expected sanitized token estimate, got ${summary.tokens}`);
});

test('/status shows image count instead of inflating image payload into size', async () => {
  const bigImage = 'b'.repeat(120_000);
  const session = createSession([
    {
      role: 'user',
      parts: [
        { text: 'image message' },
        { inlineData: { mimeType: 'image/jpeg', data: bigImage } },
      ],
    },
  ]);

  let replyText = '';
  const ctx: ChannelContext = {
    channelUserId: 'webui',
    conversationId: 'token-status-test',
    channelId: 'webui',
    channelType: 'webui',
    username: 'tester',
    senderId: 'tester',
    platform: 'webui',
    reply: async (text: string) => { replyText = text; },
    sendTyping: async () => {},
  };

  await COMMANDS['/status'].handler(ctx, [], session.id, session);
  assert.match(replyText, /Images: 1/);
  assert.doesNotMatch(replyText, /30000|20000|10000/);
});
