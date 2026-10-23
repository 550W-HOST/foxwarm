// Execute the retained Source adapter/uploader and installed ws client, without vendor traffic.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root = await mkdtemp(join(tmpdir(), 'foxwarm-qq-source-'));
await mkdir(join(root, 'state')); await writeFile(join(root, 'state/config.yaml'), '{}');
process.env.FOXWARM_DATA_DIR = root;
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
const { QQBotChannel } = require(resolve(process.env.FOXWARM_TS_ROOT || '.', 'lib/channels/qqbotChannel.js'));
const { uploadQQBotFile } = require(resolve(process.env.FOXWARM_TS_ROOT || '.', 'lib/channels/qqbotMediaUpload.js'));
const sockets = [], frames = [], requests = [], received = [];
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await once(server, 'listening');
server.on('connection', ws => {
  sockets.push(ws); ws.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 0 } }));
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const transport = async (url, init) => {
  if (String(url).endsWith('/getAppAccessToken')) return response({ access_token: 'fixture-token', expires_in: 7200 });
  if (String(url).endsWith('/gateway')) return response({ url: `ws://127.0.0.1:${server.address().port}` });
  assert(String(url).startsWith('https://api.sgroup.qq.com/'));
  const body = JSON.parse(init.body); requests.push({ path: new URL(url).pathname, body });
  if (body.msg_id === 'expired' && body.content === 'expiration') return response({ code: 40034005 }, 400);
  if (String(url).endsWith('/files')) return response({ file_info: 'fixture-info' });
  return response({ id: 'outgoing' });
};
const channel = new QQBotChannel({ appId: 'fixture-app', clientSecret: 'fixture-secret' }, 'qq', { fetch: transport });
channel.onMessage(async (ctx, message) => received.push({ ctx, message }));
const wait = async fn => { for (let i = 0; i < 500; i++) { if (fn()) return; await new Promise(done => setTimeout(done, 10)); } throw Error('fixture timeout'); };
const event = (id, content, sender = 'alice') => ({ id, content, group_openid: 'room', author: { member_openid: sender, user_openid: sender, username: sender } });
const push = (type, body, sequence = 2) => sockets.at(-1).send(JSON.stringify({ op: 0, t: type, s: sequence, d: body }));
try {
  await channel.start(); await wait(() => frames.length > 0);
  assert.equal(frames[0].op, 2); assert.equal(frames[0].d.intents, 1174409216);
  push('GROUP_MESSAGE_CREATE', event('ambient', '</tag>& ambient', 'other'));
  push('GROUP_MESSAGE_CREATE', event('trigger', 'ordinary representation'));
  push('GROUP_AT_MESSAGE_CREATE', event('trigger', 'current'));
  await wait(() => received.length === 1);
  assert(received[0].message.parts[0].text.includes('&lt;/tag&gt;&amp; ambient'));
  assert(!received[0].message.parts[0].text.includes('ordinary representation'));
  assert(received[0].message.ingressMetadataParts[0].system.includes('mentioned="true"'));
  push('GROUP_AT_MESSAGE_CREATE', event('trigger', 'duplicate'), 5);
  push('GROUP_AT_MESSAGE_CREATE', event('latest', 'latest trigger'));
  await wait(() => received.length === 2);
  await channel.sendMessage('group:room', 'direct');
  await channel.sendMessage('group:room', 'automatic', { channelProgressTurnId: 'turn' });
  await received[0].ctx.reply('explicit');
  assert.equal(requests.find(item => item.body.content === 'direct').body.msg_id, undefined);
  assert.equal(requests.find(item => item.body.content === 'automatic').body.msg_id, 'latest');
  assert.equal(requests.find(item => item.body.content === 'explicit').body.msg_id, 'trigger');
  const path = join(root, 'tiny.bin'); await writeFile(path, 'unchanged bytes');
  await channel.sendFile('group:room', { path, name: 'tiny.bin', mimeType: 'image/png', isImage: true, sizeBytes: 0 }, { caption: 'caption' });
  const direct = requests.find(item => item.path.endsWith('/files'));
  assert.equal(direct.body.file_type, 4); assert.equal(direct.body.srv_send_msg, false);
  assert.equal(Buffer.from(direct.body.file_data, 'base64').toString(), 'unchanged bytes');
  assert.equal(requests.at(-1).body.msg_id, 'latest');
  push('C2C_MESSAGE_CREATE', event('expired', 'C2C'));
  await wait(() => received.length === 3);
  await channel.sendMessage('c2c:alice', 'expiration', { turnFinal: true });
  const fallback = requests.filter(item => item.body.content === 'expiration');
  assert.equal(fallback.length, 2); assert.equal(fallback[0].body.msg_seq, fallback[1].body.msg_seq); assert(!fallback[1].body.msg_id);
  const data = Buffer.alloc(10002433); for (let i = 0; i < data.length; i++) data[i] = (i * 31 + Math.floor(i / 97)) & 255;
  const largePath = join(root, 'large.bin'); await writeFile(largePath, data);
  let hashes; const stages = []; let putBytes = 0;
  await uploadQQBotFile('c2c', 'alice', { path: largePath, name: 'large.bin' }, undefined, {
    request: async (path, body) => {
      stages.push(path.split('/').at(-1));
      if (path.endsWith('/upload_prepare')) { hashes = body; return { upload_id: 'fixture-upload', block_size: data.length, parts: [{ index: 1, presigned_url: 'https://cos.myqcloud.com/part' }] }; }
      if (path.endsWith('/files')) return { file_info: 'fixture-info' };
      return {};
    },
    fetch: async (url, init) => {
      assert.equal(init.redirect, 'error'); assert(!init.headers.Authorization);
      const reader = init.body.getReader(); while (true) { const next = await reader.read(); if (next.done) break; putBytes += next.value.length; }
      return new Response(null, { status: 200 });
    }
  });
  assert.equal(putBytes, data.length);
  assert.equal(hashes.md5_10m, crypto.createHash('md5').update(data.subarray(0, 10002432)).digest('hex'));
  assert.deepEqual(stages, ['upload_prepare', 'upload_part_finish', 'files']);
  console.log('QQBOT_SOURCE_FIXTURE:' + JSON.stringify({ identities: received.map(item => item.ctx.conversationId), groupUpgrade: true, triggerMetadata: true, directProactive: true, automaticLatest: true, explicitOriginal: true, directSmallGeneric: true, mediaLatest: true, expirationSameSequence: true, md5_10m: hashes.md5_10m, streamedStages: stages }));
} finally {
  await channel.stop(); for (const ws of server.clients) ws.terminate(); await new Promise(done => server.close(done));
}
// The default ws client supplies its own 30-second close timer. A silent peer never answers Close.
const raw = createServer(); const rawSockets = [];
raw.on('upgrade', (request, socket) => {
  rawSockets.push(socket);
  const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('data', () => {}); // Consume TCP without interpreting or acknowledging websocket Close.
});
raw.listen(0, '127.0.0.1'); await once(raw, 'listening');
let client;
try {
  client = new WebSocket(`ws://127.0.0.1:${raw.address().port}`); await once(client, 'open');
  const begin = Date.now(); const closed = once(client, 'close'); client.close();
  assert.equal(client.readyState, WebSocket.CLOSING);
  await closed;
  const elapsed = Date.now() - begin;
  assert(elapsed >= 29000 && elapsed < 35000, `ws default close lifetime ${elapsed}`);
  console.log('QQBOT_WS_LIFETIME:' + JSON.stringify({ defaultCloseMilliseconds: elapsed, queuedSendOwner: 'installed ws Sender', closeWaitsForPeerOr30SecondTimer: true }));
} finally {
  client?.terminate(); for (const socket of rawSockets) socket.destroy(); await new Promise(done => raw.close(done));
  await rm(root, { recursive: true, force: true });
}
