// Loopback qualification of the retained reference WeWork callback/stream contract.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'foxwarm-wework-source-'));
await mkdir(join(root, 'state'));
await writeFile(join(root, 'state/config.yaml'), '{}');
const { isolatedApplicationEnv } = await import('../scripts/test/test-process-env.cjs');
Object.assign(process.env, isolatedApplicationEnv(root));
const require = createRequire(import.meta.url);
const { WeWorkWebhookChannel } = require(resolve(process.env.FOXWARM_TS_ROOT || '.', 'lib/channels/weworkChannel.js'));
// Source has no listen-host option. Restrict this fixture's listener to its owned loopback endpoint.
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1, 0, '127.0.0.1');
  return originalListen.apply(this, args);
};
const token = 'fixture-token';
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const sign = (encrypted, timestamp = '1710000000', nonce = 'fixture-nonce') => crypto.createHash('sha1').update([token, timestamp, nonce, encrypted].sort().join('')).digest('hex');
function encrypt(text) {
  const content = Buffer.from(text), length = Buffer.alloc(4); length.writeUInt32BE(content.length);
  const raw = Buffer.concat([Buffer.alloc(16, 42), length, content, Buffer.from('recv-id')]);
  const pad = 32 - raw.length % 32;
  const cipher = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(pad, pad)])), cipher.final()]).toString('base64');
}
function decode(payload) {
  if (!payload.encrypt) return payload;
  assert.equal(payload.msgsignature, sign(payload.encrypt, String(payload.timestamp), payload.nonce));
  const cipher = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  const raw = Buffer.concat([cipher.update(Buffer.from(payload.encrypt, 'base64')), cipher.final()]);
  assert.equal(raw.length % 32, 0);
  return JSON.parse(raw.subarray(20, 20 + raw.readUInt32BE(16)).toString());
}
const server = net.createServer();
await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
await new Promise(done => server.close(done));
const channel = new WeWorkWebhookChannel({ listenPort: port, listenPath: '/callback', token, encodingAESKey: key.toString('base64').replace(/=+$/, ''), aibot: { stream: true } }, 'fixture');
const messages = [];
channel.onMessage(async (ctx, message) => { messages.push({ ctx, message }); });
const base = `http://127.0.0.1:${port}/callback`;
async function post(body, signed = true, xml = false) {
  const encrypted = encrypt(typeof body === 'string' ? body : JSON.stringify(body));
  const query = signed ? `?timestamp=1710000000&nonce=fixture-nonce&msg_signature=${sign(encrypted)}` : '';
  const response = await fetch(base + query, { method: 'POST', headers: { 'content-type': xml ? 'text/xml' : 'application/json' },
    body: xml ? `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>` : JSON.stringify({ encrypt: encrypted }) });
  assert.equal(response.status, 200);
  const raw = await response.text();
  return raw ? decode(JSON.parse(raw)) : null;
}
const text = (msgid, content = 'hello') => ({ msgid, aibotid: 'bot', chatid: 'conversation', chattype: 'group', from: { userid: 'alice' }, msgtype: 'text', text: { content } });
const refresh = id => post({ msgtype: 'stream', stream: { id } });
let replacement;
try {
  await channel.start();
  assert.equal((await fetch(base)).status, 400);
  const echo = encrypt('verified 企业微信');
  assert.equal((await fetch(`${base}?timestamp=1710000000&nonce=fixture-nonce&echostr=${encodeURIComponent(echo)}&msg_signature=bad`)).status, 401);
  assert.equal(await (await fetch(`${base}?timestamp=1710000000&nonce=fixture-nonce&echostr=${encodeURIComponent(echo)}&msg_signature=${sign(echo)}`)).text(), 'verified 企业微信');
  const first = await post(text('first'));
  assert.equal(first.stream.content, '<think>');
  assert.equal((await post(text('first'))).stream.id, first.stream.id);
  assert.equal(messages.length, 1);
  await channel.sendMessage('conversation', 'substantive');
  await channel.handleTurnLifecycle('conversation', { channelTurnProgress: { type: 'tool-calls-start', calls: [{ id: 'r', name: 'read' }] } });
  const second = await post(text('second'), false);
  const old = await refresh(first.stream.id);
  assert.deepEqual({ content: old.stream.content, finish: old.stream.finish }, { content: 'substantive', finish: true });
  await messages.at(-1).ctx.reply('explicit reply'); // Both stream binding and configured webhook still select stream.
  await channel.sendMessage('conversation', '', { channelTurnProgress: { type: 'tool-calls-start', text: 'model text', calls: [{ id: 'a', name: 'exec' }, { id: 'b', name: 'read' }, { id: 'c', name: 'exec' }] } });
  await channel.sendMessage('conversation', '', { channelTurnProgress: { type: 'tool-calls-finish', results: [{ id: 'a', name: 'exec', status: 'success' }, { id: 'c', name: 'exec', status: 'success' }] } });
  await channel.sendMessage('conversation', '', { channelTurnProgress: { type: 'llm-start' } });
  assert.equal((await refresh(second.stream.id)).stream.content, '<think>\nexplicit reply\n\nmodel text\n\n> ☑️ exec ×2 | ⌛️ read | 🤔 thinking');
  await channel.handleTurnLifecycle('conversation', { turnSuspended: true });
  assert.equal((await refresh(second.stream.id)).stream.finish, false);
  await channel.sendMessage('conversation', 'done', { turnFinal: true });
  const final = await refresh(second.stream.id);
  assert.equal(final.stream.finish, true);
  assert.equal(final.stream.content, '<think>\nexplicit reply\n\nmodel text\n\n> ☑️ exec ×2 | ⌛️ read\n</think>\ndone');
  const xml = '<xml><MsgId>xml</MsgId><From><UserId>alice</UserId><Name>XML sender</Name></From><ChatId>xml-chat</ChatId><MsgType>text</MsgType><Content><![CDATA[XML content]]></Content></xml>';
  assert.deepEqual(await post(xml, true, true), { code: 0, msg: 'success' });
  assert.equal(messages.at(-1).ctx.conversationId, 'xml-chat');
  const rawCipher = encrypt(JSON.stringify(text('bad')));
  const mismatch = await fetch(`${base}?timestamp=1710000000&nonce=fixture-nonce&msg_signature=bad`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ encrypt: rawCipher }) });
  assert.equal(mismatch.status, 500);
  const plain = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(text('plain')) });
  assert.equal(plain.status, 200); const plainCard = JSON.parse(await plain.text()); assert.equal(plainCard.msgtype, 'stream');
  await channel.stop();
  replacement = new WeWorkWebhookChannel({ listenPort: port, listenPath: '/callback', token, encodingAESKey: key.toString('base64').replace(/=+$/, ''), aibot: { stream: true } }, 'replacement');
  await replacement.start();
  let afterStop;
  try { afterStop = await refresh(plainCard.stream.id); } catch { afterStop = { transportClosed: true }; }
  assert(afterStop.transportClosed || afterStop.stream?.finish && afterStop.stream.content === '未找到对应的流式消息。');
  console.log('WEWORK_SOURCE_STOP:' + JSON.stringify(afterStop));
  console.log('WEWORK_SOURCE_FIXTURE:' + JSON.stringify({ verification: true, conditionalPostSignature: true, framedCrypto32BytePadding: true, pureCallbackStream: true, dedup: true, latestSupersession: old.stream, nativeProgress: final.stream, xml: true }));
} finally {
  await channel.stop();
  await replacement?.stop();
  net.Server.prototype.listen = originalListen;
  await rm(root, { recursive: true, force: true });
}
