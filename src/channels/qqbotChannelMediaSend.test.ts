import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { registerChannel, unregisterChannel } from '../channel';
import { sendFileToChannelTargetId } from '../session/channels';
import { tool_send_file } from '../toolsSessionAgent/interSession';
import type { ChannelFile } from '../channel';
import { QQBotChannel } from './qqbotChannel';
import { QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES } from './qqbotMediaUpload';

const API_PREFIX = 'https://api.sgroup.qq.com';
const COS_PREFIX = 'https://cos.ap-guangzhou.myqcloud.com';

type Call = { url: string; init?: RequestInit };

async function withTempFiles(callback: (paths: { png: string; generic: string }) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-qqbot-channel-send-test-'));
  const png = path.join(dir, 'photo.png');
  const generic = path.join(dir, 'report.txt');
  const pngBytes = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  await fs.writeFile(png, pngBytes);
  await fs.writeFile(generic, Buffer.from('generic-payload'));
  try {
    await callback({ png, generic });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function file(filePath: string, name: string, mimeType: string, isImage: boolean): ChannelFile {
  return { path: filePath, name, mimeType, isImage, sizeBytes: 0 };
}

function activate(channel: QQBotChannel): void {
  (channel as any).stopped = false;
  (channel as any).connectionGeneration = 1;
}

function createFetchTransport(options: { failRichMedia?: boolean; failExpiredPassiveMedia?: boolean; delayPrepare?: boolean; blockSize?: number } = {}) {
  const calls: Call[] = [];
  const partBodies: Buffer[] = [];
  let prepareStartedResolve: (() => void) | undefined;
  let releasePrepareResolve: (() => void) | undefined;
  const prepareStarted = new Promise<void>(resolve => { prepareStartedResolve = resolve; });
  const prepareGate = new Promise<void>(resolve => { releasePrepareResolve = resolve; });
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlText = String(url);
    calls.push({ url: urlText, init });
    if (urlText.includes('getAppAccessToken')) {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 }), { status: 200 });
    }
    if (urlText.startsWith(COS_PREFIX)) {
      const body = init?.body instanceof ReadableStream
        ? Buffer.from(await new Response(init.body).arrayBuffer())
        : Buffer.alloc(0);
      partBodies.push(body);
      return new Response(null, { status: 200 });
    }
    const parsed = new URL(urlText);
    if (parsed.pathname.endsWith('/upload_prepare')) {
      prepareStartedResolve?.();
      if (options.delayPrepare) await prepareGate;
      const requestBody = JSON.parse(String(init?.body || '{}')) as { file_size: number };
      const blockSize = options.blockSize ?? 8;
      const count = Math.ceil(requestBody.file_size / blockSize);
      return new Response(JSON.stringify({
        upload_id: `upload-${parsed.pathname.includes('/groups/') ? 'group' : 'c2c'}`,
        block_size: blockSize,
        parts: Array.from({ length: count }, (_, index) => ({
          index: index + 1,
          presigned_url: `${COS_PREFIX}/part/${index + 1}?signature=opaque`,
        })),
      }), { status: 200 });
    }
    if (parsed.pathname.endsWith('/upload_part_finish')) return new Response('{}', { status: 200 });
    if (parsed.pathname.endsWith('/files')) return new Response(JSON.stringify({ file_info: `file-info-${parsed.pathname.includes('/groups/') ? 'group' : 'c2c'}` }), { status: 200 });
    if (parsed.pathname.endsWith('/messages')) {
      const body = JSON.parse(String(init?.body || '{}')) as { msg_type?: number; msg_id?: string };
      if (options.failExpiredPassiveMedia && body.msg_type === 7 && body.msg_id) {
        return new Response(JSON.stringify({ code: 40034005, message: '回复消息msg_id已过期' }), { status: 400 });
      }
      if (options.failRichMedia && body.msg_type === 7) {
        return new Response(JSON.stringify({ code: 40034105, message: '主动消息失败, 无权限' }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  return {
    fetch,
    calls,
    partBodies,
    prepareStarted,
    releasePrepare: () => releasePrepareResolve?.(),
  };
}

function apiCalls(transport: ReturnType<typeof createFetchTransport>, suffix: string): Call[] {
  return transport.calls.filter(call => call.url.startsWith(API_PREFIX) && new URL(call.url).pathname.endsWith(suffix));
}

function body(call: Call): any {
  return JSON.parse(String(call.init?.body || '{}'));
}

test('QQ Bot sendFile uses latest C2C passive ID and direct-small image/file upload', async () => {
  await withTempFiles(async paths => {
    const transport = createFetchTransport();
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-send-c2c', { fetch: transport.fetch });
    activate(channel);
    await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'latest-c2c-message', content: 'inbound', author: { user_openid: 'openid-1' },
    });

    const caption = 'x'.repeat(2_100);
    await channel.sendFile('c2c:openid-1', file(paths.png, 'photo.png', 'image/png', true), { caption });
    await channel.sendFile('c2c:openid-1', file(paths.generic, 'report.txt', 'text/plain', false));

    const messages = apiCalls(transport, '/messages');
    assert.equal(messages.length, 2);
    assert.equal(body(messages[0]).msg_type, 7);
    assert.equal(body(messages[0]).media.file_info, 'file-info-c2c');
    assert.equal(body(messages[0]).srv_send_msg, undefined);
    assert.equal(body(messages[0]).msg_id, 'latest-c2c-message');
    assert.equal(body(messages[0]).msg_seq, 1);
    assert.equal(body(messages[0]).content.length, 2_000);
    assert.equal(body(messages[1]).media.file_info, 'file-info-c2c');
    assert.equal(body(messages[1]).msg_id, 'latest-c2c-message');
    assert.equal(body(messages[1]).msg_seq, 2);
    const directFiles = apiCalls(transport, '/files');
    assert.equal(directFiles.length, 2);
    assert.equal(body(directFiles[0]).file_type, 1);
    assert.equal(body(directFiles[0]).srv_send_msg, false);
    assert.equal(body(directFiles[0]).file_data, (await fs.readFile(paths.png)).toString('base64'));
    assert.equal(body(directFiles[0]).file_name, undefined);
    assert.equal(body(directFiles[1]).file_type, 4);
    assert.equal(body(directFiles[1]).srv_send_msg, false);
    assert.equal(body(directFiles[1]).file_name, 'report.txt');
    assert.equal(body(directFiles[1]).file_data, (await fs.readFile(paths.generic)).toString('base64'));
    assert.equal(apiCalls(transport, '/upload_prepare').length, 0);
    assert.equal(apiCalls(transport, '/upload_part_finish').length, 0);
    const putCalls = transport.calls.filter(call => call.url.startsWith(COS_PREFIX));
    assert.equal(putCalls.length, 0);
  });
});

test('QQ Bot sendFile uses Group direct-small/message routes and a persisted passive ID after latest-state loss', async () => {
  await withTempFiles(async paths => {
    const transport = createFetchTransport();
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-send-group', { fetch: transport.fetch });
    activate(channel);
    await channel.sendFile('group:group-openid', file(paths.generic, 'clip.mp4', 'video/mp4', false), {
      qqbotChannelId: 'qq-send-group',
      qqbotConversationId: 'group:group-openid',
      qqbotMessageId: 'persisted-group-message',
    });
    const directFile = apiCalls(transport, '/files')[0];
    const message = apiCalls(transport, '/messages')[0];
    assert.equal(directFile.url, `${API_PREFIX}/v2/groups/group-openid/files`);
    assert.equal(body(directFile).file_type, 4);
    assert.equal(body(directFile).srv_send_msg, false);
    assert.equal(body(directFile).file_name, 'clip.mp4');
    assert.equal(body(directFile).file_data, (await fs.readFile(paths.generic)).toString('base64'));
    assert.equal(apiCalls(transport, '/upload_prepare').length, 0);
    assert.equal(transport.calls.filter(call => call.url.startsWith(COS_PREFIX)).length, 0);
    assert.equal(message.url, `${API_PREFIX}/v2/groups/group-openid/messages`);
    assert.equal(body(message).msg_id, 'persisted-group-message');
    assert.equal(body(message).msg_seq, 1);
  });
});

test('QQ Bot media passive state and opaque file_info stay isolated per adapter instance', async () => {
  await withTempFiles(async paths => {
    const firstTransport = createFetchTransport();
    const secondTransport = createFetchTransport();
    const first = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-instance-one', { fetch: firstTransport.fetch });
    const second = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-instance-two', { fetch: secondTransport.fetch });
    activate(first);
    activate(second);
    await (first as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'instance-one-message', content: 'one', author: { user_openid: 'same-openid' },
    });
    await (second as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'instance-two-message', content: 'two', author: { user_openid: 'same-openid' },
    });
    await first.sendFile('c2c:same-openid', file(paths.generic, 'one.txt', 'text/plain', false));
    await second.sendFile('c2c:same-openid', file(paths.generic, 'two.txt', 'text/plain', false));
    const firstMessage = apiCalls(firstTransport, '/messages')[0];
    const secondMessage = apiCalls(secondTransport, '/messages')[0];
    assert.equal(body(firstMessage).msg_id, 'instance-one-message');
    assert.equal(body(secondMessage).msg_id, 'instance-two-message');
    assert.equal(body(firstMessage).media.file_info, 'file-info-c2c');
    assert.equal(body(secondMessage).media.file_info, 'file-info-c2c');
    assert.equal(apiCalls(firstTransport, '/files').length, 1);
    assert.equal(apiCalls(secondTransport, '/files').length, 1);
    assert.equal(apiCalls(firstTransport, '/upload_prepare').length, 0);
    assert.equal(apiCalls(secondTransport, '/upload_prepare').length, 0);
  });
});

test('QQ Bot media counts toward passive quota and the fifth operation makes exactly one proactive attempt', async () => {
  await withTempFiles(async paths => {
    const transport = createFetchTransport();
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-send-fifth', { fetch: transport.fetch });
    activate(channel);
    await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'latest-group-message', content: 'inbound', group_openid: 'group-openid', author: { member_openid: 'member-openid' },
    });
    for (let index = 0; index < 4; index += 1) {
      await channel.sendMessage('group:group-openid', `text-${index}`, { replyToId: 'latest-group-message', qqbotSourceBound: true });
    }
    await channel.sendFile('group:group-openid', file(paths.generic, 'report.txt', 'text/plain', false));
    const messages = apiCalls(transport, '/messages').map(body);
    assert.equal(messages.length, 5);
    assert.equal(messages.slice(0, 4).every(item => item.msg_id === 'latest-group-message'), true);
    assert.equal(messages.slice(0, 4).map(item => item.msg_seq).join(','), '1,2,3,4');
    assert.equal(messages[4].msg_type, 7);
    assert.equal(messages[4].msg_id, undefined);
    assert.equal(messages[4].msg_seq, 1);
  });
});

test('QQ Bot media POST failure surfaces the group permission error without fallback or retry', async () => {
  await withTempFiles(async paths => {
    const transport = createFetchTransport({ failRichMedia: true });
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-send-failure', { fetch: transport.fetch });
    activate(channel);
    await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'permission-message', content: 'inbound', group_openid: 'group-openid', author: { member_openid: 'member-openid' },
    });
    await assert.rejects(channel.sendFile('group:group-openid', file(paths.generic, 'report.txt', 'text/plain', false)), /40034105/);
    assert.equal(apiCalls(transport, '/messages').length, 1);
    assert.equal(body(apiCalls(transport, '/messages')[0]).msg_id, 'permission-message');
  });
});

test('QQ Bot media expiration retries the final message proactively without re-uploading', async () => {
  await withTempFiles(async paths => {
    const transport = createFetchTransport({ failExpiredPassiveMedia: true });
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-media-expired', { fetch: transport.fetch });
    activate(channel);
    await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'media-expired-message', content: 'inbound', group_openid: 'group-openid', author: { member_openid: 'member-openid' },
    });

    await channel.sendFile('group:group-openid', file(paths.generic, 'report.txt', 'text/plain', false));

    const directFiles = apiCalls(transport, '/files');
    const messages = apiCalls(transport, '/messages').map(body);
    assert.equal(directFiles.length, 1);
    assert.equal(body(directFiles[0]).file_type, 4);
    assert.equal(body(directFiles[0]).srv_send_msg, false);
    assert.equal(body(directFiles[0]).file_name, 'report.txt');
    assert.equal(apiCalls(transport, '/upload_prepare').length, 0);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].msg_id, 'media-expired-message');
    assert.equal(messages[0].msg_seq, 1);
    assert.equal(messages[1].msg_id, undefined);
    assert.equal(messages[1].msg_seq, 1);
    assert.equal(messages[1].media.file_info, messages[0].media.file_info);
  });
});

test('QQ Bot media generation fence stops before final POST and Guild/DM stay explicitly unsupported', async () => {
  await withTempFiles(async paths => {
    await fs.truncate(paths.generic, QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES + 1);
    const transport = createFetchTransport({ delayPrepare: true, blockSize: QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES + 1 });
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-send-fence', { fetch: transport.fetch });
    activate(channel);
    const sending = channel.sendFile('c2c:openid-1', file(paths.generic, 'report.txt', 'text/plain', false));
    await transport.prepareStarted;
    await channel.stop();
    transport.releasePrepare();
    await assert.rejects(sending, /invalidated before final delivery/);
    assert.equal(apiCalls(transport, '/messages').length, 0);
    await assert.rejects(channel.sendFile('guild:channel-1', file(paths.generic, 'report.txt', 'text/plain', false)), /unsupported/);
    await assert.rejects(channel.sendFile('dm:guild-1', file(paths.generic, 'report.txt', 'text/plain', false)), /unsupported/);
  });
});

test('send_file channel-target integration invokes QQ Bot sendFile', async () => {
  await withTempFiles(async paths => {
    const transport = createFetchTransport();
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-send-tool', { fetch: transport.fetch });
    activate(channel);
    await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'tool-latest-message', content: 'inbound', author: { user_openid: 'openid-tool' },
    });
    registerChannel('qq-send-tool', channel);
    try {
      await sendFileToChannelTargetId('qq-send-tool:c2c:openid-tool', file(paths.generic, 'report.txt', 'text/plain', false), { caption: 'tool caption' });
    } finally {
      unregisterChannel('qq-send-tool');
    }
    const message = apiCalls(transport, '/messages')[0];
    assert.equal(body(message).msg_id, 'tool-latest-message');
    assert.equal(body(message).content, 'tool caption');
  });
});

test('tool_send_file carries only matching current-turn QQ metadata for restart fallback', async () => {
  await withTempFiles(async paths => {
    const transport = createFetchTransport();
    const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-send-tool-context', { fetch: transport.fetch });
    activate(channel);
    registerChannel('qq-send-tool-context', channel);
    try {
      const currentTurnMetadata = {
        channelReplyMetadata: {
          qqbotChannelId: 'qq-send-tool-context',
          qqbotConversationId: 'c2c:openid-restart',
          qqbotMessageId: 'persisted-tool-message',
        },
      };
      await tool_send_file({
        channelTargetId: 'qq-send-tool-context:c2c:openid-restart',
        filePath: paths.generic,
        caption: 'restart fallback',
      }, currentTurnMetadata);
      await tool_send_file({
        channelTargetId: 'qq-send-tool-context:group:other-group',
        filePath: paths.generic,
        caption: 'mismatched target',
      }, currentTurnMetadata);
    } finally {
      unregisterChannel('qq-send-tool-context');
    }
    const messages = apiCalls(transport, '/messages').map(body);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].msg_id, 'persisted-tool-message');
    assert.equal(messages[0].msg_seq, 1);
    assert.equal(messages[0].content, 'restart fallback');
    assert.equal(messages[1].msg_id, undefined);
    assert.equal(messages[1].msg_seq, 1);
    assert.equal(messages[1].content, 'mismatched target');
  });
});
