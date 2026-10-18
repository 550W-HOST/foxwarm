// Controlled homeserver probe for the pinned SDK path used by the reference adapter.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import * as sdk from 'matrix-js-sdk';
const require = createRequire(import.meta.url);
const calls = [];
const timelines = [];
const memberships = [];
let syncs = 0, retryAttempts = 0;
const versions = process.env.MATRIX_FIXTURE_THREADS === '1' ? ['v1.4', 'v1.11'] : ['v1.11'];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url, 'http://fixture');
  calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization ?? null,
    contentType: req.headers['content-type'], body: raw.length ? raw.toString() : null });
  const json = (value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.endsWith('/versions')) return json({ versions, unstable_features: {} });
  if (url.pathname.endsWith('/capabilities')) return json({ capabilities: {} });
  if (url.pathname.endsWith('/pushrules/')) return json({ global: {} });
  if (url.pathname.endsWith('/filter')) return json({ filter_id: 'fixture-filter' });
  if (url.pathname.endsWith('/sync')) {
    syncs++;
    if (syncs > 2) { req.on('close', () => res.destroy()); return; }
    const event = { type: 'm.room.message', event_id: `$event${syncs}`, sender: '@sender:fixture', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: 'fixture' } };
    return json({ next_batch: `cursor-${syncs}`, rooms: {
      join: { '!room:fixture': { state: { events: [] }, timeline: { events: [event], prev_batch: 'before', limited: false }, ephemeral: { events: [] }, account_data: { events: [] } } },
      ...(syncs === 1 ? { invite: { '!invite:fixture': { invite_state: { events: [{ type: 'm.room.member', state_key: '@bot:fixture', sender: '@owner:fixture', content: { membership: 'invite' } }] } } } } : {})
    }, to_device: { events: [] } });
  }
  if (url.pathname.includes('/join/')) return json({ room_id: '!invite:fixture' });
  if (url.pathname.endsWith('/upload')) return json({ content_uri: 'mxc://fixture/uploaded' });
  if (url.pathname.includes('/send/')) {
    if (JSON.parse(raw).body === 'retry' && ++retryAttempts === 1) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1 })); }
    return json({ event_id: '$sent' });
  }
  if (url.pathname.includes('/typing/')) return json({});
  if (url.pathname.includes('/download/')) { res.writeHead(200); return res.end('fixture-media'); }
  res.writeHead(404); res.end(JSON.stringify({ errcode: 'M_UNRECOGNIZED', error: url.pathname }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const client = sdk.createClient({ baseUrl, accessToken: 'synthetic-token', userId: '@bot:fixture' });
client.logger.disableAll();
client.on('Room.timeline', (event, room, toStartOfTimeline) => timelines.push({ id: event.getId(), room: room.roomId, toStartOfTimeline }));
client.on('RoomMember.membership', (_, member) => {
  memberships.push({ userId: member.userId, room: member.roomId, membership: member.membership });
  if (member.userId === '@bot:fixture' && member.membership === 'invite') void client.joinRoom(member.roomId);
});
try {
  await client.startClient({ initialSyncLimit: 10 });
  const deadline = Date.now() + 8000;
  while ((syncs < 3 || !calls.some(call => call.path.includes('/join/'))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(syncs, 3);
  await client.sendEvent('!room:fixture', 'm.room.message', { msgtype: 'm.text', body: 'text' });
  await client.sendEvent('!room:fixture', 'm.room.message', { msgtype: 'm.text', body: 'retry' });
  const retries = calls.filter(call => call.path.includes('/send/') && JSON.parse(call.body).body === 'retry');
  assert.equal(retries.length, 2); assert.equal(retries[0].path, retries[1].path);
  await client.sendTyping('!room:fixture', true, 3000);
  await client.uploadContent(Buffer.from('file'), { type: 'text/plain', name: 'unicode 文.txt' });
  const media = client.mxcUrlToHttp('mxc://media.fixture/id_1');
  await fetch(media);
  const first = calls.find(call => call.path.endsWith('/sync'));
  assert.equal(JSON.parse(first.query.filter).room.timeline.limit, 10);
  if (versions.includes('v1.4')) assert.equal(JSON.parse(first.query.filter).room.timeline['org.matrix.msc3773.unread_thread_notifications'] ?? JSON.parse(first.query.filter).room.timeline.unread_thread_notifications, true);
  assert.equal(calls.filter(call => call.path.endsWith('/sync'))[1].query.filter, 'fixture-filter');
  assert.equal(calls.filter(call => call.path.endsWith('/sync'))[1].query.since, 'cursor-1');
  assert.ok(timelines.every(event => !event.toStartOfTimeline));
  assert.equal(new URL(media).pathname, '/_matrix/media/v3/download/media.fixture/id_1');
  assert.equal(calls.find(call => call.path.includes('/download/')).authorization, null);
  assert.equal(client.mxcUrlToHttp('https://other.invalid/file'), '');
  process.stdout.write(JSON.stringify({ sdkVersion: require('matrix-js-sdk/package.json').version, calls, timelines, memberships, mediaPath: new URL(media).pathname }, null, 2) + '\n');
} finally {
  client.stopClient();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
// The SDK has module-level request timeout timers; this probe has already stopped its client and server.
process.exit(0);
