import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { HttpServer } from '../httpServer';
import { registerWebUiFileDownloads, registerWebUiBlobDownloads } from './webuiFileDownloads';
import { putImageBlob, resolveImageBlobPath } from '../imageBlobs';

const token = 'synthetic-download-admin';
const cookie = { Cookie: `foxwarm_token=${token}` };
const bearer = { Authorization: `Bearer ${token}` };

async function fixture(run: (env: { base: string; dir: string; setNow: (time: number) => void }) => Promise<void>, instanceToken = token) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-delivery-download-'));
  await fs.writeFile(path.join(dir, 'cached.png'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(dir, 'active.svg'), '<svg/>');
  const server = new HttpServer(0, instanceToken);
  server.setWebUiIdentityVerifier(value => value === 'scoped-webui' ? { role: 'webui', identityId: 'reader', sessionIds: [] } : null);
  let time = 1_800_000_000_000;
  const signatures = registerWebUiFileDownloads(server, instanceToken, () => time);
  registerWebUiBlobDownloads(server, signatures, async (_req, res) => {
    res.status(403).json({ error: 'Forbidden' }); return false;
  });
  // Reproduce the WebUI's static login gate after route registration. Signed
  // requests must reach the production download route rather than this page.
  server.app.use((_req, res) => { res.type('html').send('<html>Login</html>'); });
  await server.start();
  const base = `http://127.0.0.1:${(server as any).httpServer.address().port}/`;
  try { await run({ base, dir, setNow: value => { time = value; } }); }
  finally { await server.stop(); await fs.remove(dir); }
}

async function issue(base: string, resource: Record<string, string>, headers: Record<string, string> = cookie) {
  return fetch(`${base}api/download/sign`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(resource),
  });
}

async function signed(base: string, resource: Record<string, string>) {
  const response = await issue(base, resource);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json() as { url: string; expiresAt: number };
  assert.equal(result.expiresAt, 1_800_000_900);
  assert.ok(!result.url.includes(token));
  return new URL(result.url, base);
}

test('real HTTP downloads support cookie/Bearer OR cookie-less signatures, safe previews, original names and HEAD', async () => {
  await fixture(async ({ base, dir }) => {
    const resource = { path: path.join(dir, 'cached.png'), filename: '报告 original.png' };
    const unsigned = new URL(`download?${new URLSearchParams(resource)}`, base);
    assert.equal((await fetch(unsigned)).status, 401);
    for (const headers of [cookie, bearer]) {
      const response = await fetch(unsigned, { headers });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3]));
    }
    const url = await signed(base, resource);
    for (const headers of [{ Cookie: 'foxwarm_token=wrong' }, { Authorization: 'Bearer scoped-webui' }]) {
      const authorizedBySignature = await fetch(url, { headers });
      assert.equal(authorizedBySignature.status, 200);
      await authorizedBySignature.arrayBuffer();
    }
    const response = await fetch(url); // Deliberately no Cookie or Authorization.
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-disposition')!, /attachment;.*filename\*=UTF-8''%E6%8A%A5%E5%91%8A%20original.png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([1, 2, 3]));
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '3');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const preview = await fetch(await signed(base, { ...resource, preview: '1' }));
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.match(preview.headers.get('content-disposition')!, /^inline/);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    await preview.arrayBuffer();
    const unsafe = await fetch(await signed(base, { path: path.join(dir, 'active.svg'), preview: '1', filename: 'pretend.png' }));
    assert.equal(unsafe.headers.get('content-type'), 'application/octet-stream');
    assert.match(unsafe.headers.get('content-disposition')!, /^attachment/);
    await unsafe.arrayBuffer();
    assert.equal((await issue(base, { path: path.join(dir, 'missing.pdf') })).status, 404);
    assert.equal((await issue(base, { path: 'relative' })).status, 400);
    assert.equal((await fetch(new URL('download?path=relative', base), { headers: cookie })).status, 400);
  });
});

test('issuance retains administrator permissions and capabilities authorize only their exact download resource', async () => {
  await fixture(async ({ base, dir }) => {
    const resource = { path: path.join(dir, 'cached.png'), filename: 'original.png', preview: '1' };
    assert.equal((await fetch(new URL(`download?${new URLSearchParams(resource)}`, base), { headers: { Authorization: 'Bearer scoped-webui' } })).status, 403);
    assert.equal((await issue(base, resource, {})).status, 401);
    assert.equal((await issue(base, resource, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await issue(base, resource, { Authorization: 'Bearer scoped-webui' })).status, 403);
    assert.equal((await issue(base, resource, bearer)).status, 200);
    const url = await signed(base, resource);
    for (const [key, value] of [
      ['path', path.join(dir, 'active.svg')], ['filename', 'changed.png'], ['preview', '0'],
      ['expires', '1800000901'], ['signature', '0'.repeat(64)], ['signature', 'malformed'],
    ]) {
      const altered = new URL(url); altered.searchParams.set(key, value);
      assert.equal((await fetch(altered)).status, 401, `${key} is bound to the grant`);
      const authenticated = await fetch(altered, { headers: cookie });
      assert.equal(authenticated.status, 200, 'invalid signatures do not veto valid cookies');
      await authenticated.arrayBuffer();
    }
    const removed = new URL(url); removed.searchParams.delete('signature');
    assert.equal((await fetch(removed)).status, 401);
    const capabilityIssuer = new URL('api/download/sign', base); capabilityIssuer.search = url.search;
    assert.equal((await fetch(capabilityIssuer, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resource) })).status, 401);
    assert.equal((await fetch(new URL('api/download/sign', base), { headers: { Authorization: `Bearer ${url.searchParams.get('signature')}` }, method: 'POST' })).status, 401);
    // Express's GET route accepts HEAD, but never grants POST download authority.
    const post = await fetch(url, { method: 'POST' });
    assert.equal(post.headers.get('content-disposition'), null);
    await post.text();
  });
});

test('expiration is checked at request start and does not veto valid credentials or interrupt an accepted stream', async () => {
  await fixture(async ({ base, dir, setNow }) => {
    const largePath = path.join(dir, 'large.bin');
    const size = 8 * 1024 * 1024;
    await fs.writeFile(largePath, Buffer.alloc(size, 0x4a));
    const url = await signed(base, { path: largePath });
    setNow(1_800_000_899_000);
    const accepted = await fetch(url);
    assert.equal(accepted.status, 200);
    const reader = accepted.body!.getReader();
    const first = await reader.read();
    let received = first.value!.byteLength;
    assert.ok(received < size, 'advance the clock while the download is still being consumed');
    setNow(1_800_000_900_000);
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
    }
    assert.equal(received, size);
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 401);
    for (const headers of [cookie, bearer]) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200); await response.arrayBuffer();
    }
  });
});

test('ordinary server recreation preserves grants, and an effective new instance token invalidates old grants', async () => {
  await fixture(async ({ base, dir }) => {
    const url = await signed(base, { path: path.join(dir, 'cached.png') });
    // Use the same resource and URL query on independently constructed servers.
    for (const [secret, expected] of [[token, 200], ['synthetic-rotated-admin', 401]] as const) {
      await fixture(async ({ base: nextBase }) => {
        const response = await fetch(new URL(`${url.pathname.slice(1)}${url.search}`, nextBase));
        assert.equal(response.status, expected);
        await response.arrayBuffer();
      }, secret);
    }
  });
});

test('blob download grants preserve safe attachment headers and use the same expiry/credential OR gate', async () => {
  const bytes = Buffer.from('<svg>signed download fixture</svg>');
  const ref = await putImageBlob({ buffer: bytes, mimeType: 'image/svg+xml', imageId: 'signed-download-fixture' });
  try {
    await fixture(async ({ base, setNow }) => {
      const source = new URL(`api/blobs/${ref.blobId}`, base);
      const issued = await fetch(`${source}/download`, {
        method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'original.svg', preview: '0' }),
      });
      assert.equal(issued.status, 200);
      const result = await issued.json() as any;
      assert.equal(result.expiresAt, 1_800_000_900);
      const url = new URL(result.url, source);
      const download = await fetch(url, { headers: { Cookie: 'foxwarm_token=wrong' } });
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), 'application/octet-stream');
      assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
      assert.match(download.headers.get('content-disposition')!, /attachment; filename="original.svg"/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(bytes.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      setNow(1_800_000_900_000);
      assert.equal((await fetch(url)).status, 401);
      for (const headers of [cookie, bearer]) {
        const authorized = await fetch(url, { headers });
        assert.equal(authorized.status, 200); await authorized.arrayBuffer();
      }
    });
  } finally { await fs.remove(resolveImageBlobPath(ref.blobId!)); }
});
