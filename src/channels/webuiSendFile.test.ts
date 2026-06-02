import test from 'node:test';
import assert from 'node:assert/strict';
import { WebUIChannel } from './webuiChannel';
import { ChannelFile } from '../channel';

test('WebUI channel implements sendFile as a successful noop', async () => {
  const file: ChannelFile = {
    path: '/tmp/demo.txt',
    name: 'demo.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    isImage: false,
  };

  assert.equal(typeof WebUIChannel.prototype.sendFile, 'function');
  await WebUIChannel.prototype.sendFile.call({} as WebUIChannel, 'test-session', file, { caption: 'demo' });
});
