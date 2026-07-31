import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionListChannels } from './sessionCmd';
import { parseSessionMoveArgs } from './helpers';

test('/session move parses an optional parent while omission preserves existing relations', () => {
  assert.deepEqual(parseSessionMoveArgs(['worker/task']), {
    newAgentName: 'worker',
    newSessionId: 'task',
  });
  assert.deepEqual(parseSessionMoveArgs(['worker/task', '--parent', 'worker/main']), {
    newAgentName: 'worker',
    newSessionId: 'task',
    parentSessionId: 'worker/main',
  });
  assert.throws(() => parseSessionMoveArgs(['worker/task', '--parent']), /Missing parent session ID/);
  assert.throws(() => parseSessionMoveArgs(['worker/task', '--unknown']), /Unknown \/session move option/);
});

test('/session list channel output excludes webui attachments and preserves other channels', () => {
  const output = formatSessionListChannels([
    'webui:agent/session',
    'telegram:12345',
    'wework:chat-1',
    'discord:guild-1',
    'telegram:webui:mentioned-in-conversation-id',
    'webui-proxy:room-1',
  ]);

  assert.equal(
    output,
    '    - channels: `telegram:12345, wework:chat-1, discord:guild-1, telegram:webui:mentioned-in-conversation-id, webui-proxy:room-1`\n',
  );
  assert.doesNotMatch(output, /(^|[`, ]+)webui:/);
});

test('/session list channel output omits the channel line when there are no attachments', () => {
  assert.equal(formatSessionListChannels([]), '');
});

test('/session list channel output omits the channel line when all attachments are webui', () => {
  assert.equal(formatSessionListChannels([
    'webui:agent/session',
    'webui:another-session',
  ]), '');
});