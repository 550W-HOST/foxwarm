import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpServer, setHttpServer } from './httpServer';
import { WebUIChannel } from './channels/webuiChannel';
import {
  listProviderModels,
  parseProviderModelListRequest,
  PROVIDER_MODEL_LIST_MAX_MODELS,
  ProviderModelListError,
} from './providerModelList';

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
}

test('OpenAI-compatible model listing uses the configured API root, auth, headers, and bounded unique ids', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const ids = Array.from({ length: PROVIDER_MODEL_LIST_MAX_MODELS + 5 }, (_, index) => ({ id: `model-${index}` }));
  ids.splice(1, 0, { id: 'model-0' });
  const models = await listProviderModels({
    providerType: 'openai-completions',
    baseUrl: 'https://provider.test/custom/v1/',
    apiKey: 'secret-key',
    extraHeaders: { authorization: 'Bearer override', 'X-Project': 'project-a' },
  }, {
    fetch: async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return jsonResponse({ data: ids });
    },
  });

  assert.equal(requestUrl, 'https://provider.test/custom/v1/models');
  const requestHeaders = new Headers(requestInit?.headers);
  assert.equal(requestHeaders.get('authorization'), 'Bearer override');
  assert.equal(requestHeaders.get('x-project'), 'project-a');
  assert.equal(requestHeaders.get('authorization')?.includes(','), false);
  assert.equal(models.length, PROVIDER_MODEL_LIST_MAX_MODELS);
  assert.equal(models[0], 'model-0');
  assert.equal(models[1], 'model-1');

  for (const providerType of ['openai', 'openai-responses', 'openai-ws']) {
    let variantUrl = '';
    assert.deepEqual(await listProviderModels({ providerType, baseUrl: 'https://provider.test/v1' }, {
      fetch: async (url) => {
        variantUrl = String(url);
        return jsonResponse({ data: [{ id: providerType }] });
      },
    }), [providerType]);
    assert.equal(variantUrl, 'https://provider.test/v1/models');
  }
});

test('Anthropic model listing uses the Messages API root contract and case-insensitive header overrides', async () => {
  let requestUrl = '';
  let requestHeaders = new Headers();
  const models = await listProviderModels({
    providerType: 'anthropic',
    baseUrl: 'https://anthropic.test/proxy',
    apiKey: 'anthropic-secret',
    extraHeaders: { 'X-Api-Key': 'anthropic-override', 'Anthropic-Version': 'custom-version', 'X-Workspace': 'workspace-a' },
  }, {
    fetch: async (url, init) => {
      requestUrl = String(url);
      requestHeaders = new Headers(init?.headers);
      return jsonResponse({ data: [{ id: 'claude-a' }, { id: ' ' }, {}, { id: 'claude-b' }] });
    },
  });

  assert.equal(requestUrl, `https://anthropic.test/proxy/v1/models?limit=${PROVIDER_MODEL_LIST_MAX_MODELS}`);
  assert.equal(requestHeaders.get('x-api-key'), 'anthropic-override');
  assert.equal(requestHeaders.get('anthropic-version'), 'custom-version');
  assert.equal(requestHeaders.get('x-workspace'), 'workspace-a');
  assert.equal(requestHeaders.get('x-api-key')?.includes(','), false);
  assert.deepEqual(models, ['claude-a', 'claude-b']);
});

test('provider model request validation is bounded and custom or virtual types stay unsupported', async () => {
  assert.deepEqual(parseProviderModelListRequest({
    providerType: ' openai ',
    baseUrl: ' https://provider.test/v1 ',
    apiKey: ' secret ',
    extraHeaders: { 'X-Number': 42, 'X-Boolean': true },
  }), {
    providerType: 'openai',
    baseUrl: 'https://provider.test/v1',
    apiKey: 'secret',
    extraHeaders: { 'X-Number': '42', 'X-Boolean': 'true' },
  });

  for (const value of [
    null,
    { providerType: 'openai', unknown: true },
    { providerType: 'openai', extraHeaders: [] as unknown[] },
    { providerType: 'openai', extraHeaders: { nested: { secret: true } } },
  ]) {
    assert.throws(() => parseProviderModelListRequest(value), ProviderModelListError);
  }

  let fetched = false;
  for (const providerType of ['company-protocol', 'session-hash', 'failover']) {
    await assert.rejects(
      listProviderModels({ providerType }, { fetch: async () => { fetched = true; return jsonResponse({ data: [] }); } }),
      (error: any) => error instanceof ProviderModelListError && error.code === 'unsupported-provider' && error.statusCode === 400,
    );
  }
  assert.equal(fetched, false);
});

test('provider model listing rejects invalid URLs, upstream status, malformed JSON, and oversized bodies without response text', async () => {
  await assert.rejects(
    listProviderModels({ providerType: 'openai', baseUrl: 'file:///tmp/provider', apiKey: 'do-not-echo' }),
    (error: any) => error instanceof ProviderModelListError
      && error.code === 'invalid-request'
      && !error.message.includes('do-not-echo'),
  );

  await assert.rejects(
    listProviderModels({ providerType: 'openai', baseUrl: 'https://provider.test/v1', apiKey: 'do-not-echo' }, {
      fetch: async () => new Response('upstream secret body', { status: 401 }),
    }),
    (error: any) => error instanceof ProviderModelListError
      && error.code === 'upstream'
      && error.upstreamStatus === 401
      && !error.message.includes('secret'),
  );

  await assert.rejects(
    listProviderModels({ providerType: 'openai', baseUrl: 'https://provider.test/v1' }, {
      fetch: async () => new Response('{not-json', { status: 200 }),
    }),
    (error: any) => error instanceof ProviderModelListError && error.code === 'invalid-response',
  );

  await assert.rejects(
    listProviderModels({ providerType: 'openai', baseUrl: 'https://provider.test/v1' }, {
      fetch: async () => new Response('{}', {
        status: 200,
        headers: { 'content-length': String(1024 * 1024 + 1) },
      }),
    }),
    (error: any) => error instanceof ProviderModelListError
      && error.code === 'invalid-response'
      && /too large/i.test(error.message),
  );
});

test('provider model listing has a hard abortable timeout', async () => {
  await assert.rejects(
    listProviderModels({ providerType: 'anthropic', baseUrl: 'https://anthropic.test' }, {
      timeoutMs: 10,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted with internal details')), { once: true });
      }),
    }),
    (error: any) => error instanceof ProviderModelListError
      && error.code === 'timeout'
      && error.statusCode === 504
      && !error.message.includes('internal'),
  );

  await assert.rejects(
    listProviderModels({ providerType: 'openai', baseUrl: 'https://provider.test/v1' }, {
      timeoutMs: 10,
      fetch: async (_url, init) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":['));
          init?.signal?.addEventListener('abort', () => controller.error(new Error('body aborted with internal details')), { once: true });
        },
      }), { status: 200 }),
    }),
    (error: any) => error instanceof ProviderModelListError
      && error.code === 'timeout'
      && error.statusCode === 504
      && !error.message.includes('internal'),
  );
});

test('WebUI provider model list route is authenticated and rejects unsupported types without outbound access', async () => {
  const token = 'provider-model-list-route-token';
  const port = 35500 + Math.floor(Math.random() * 300);
  const server = new HttpServer(port, token);
  setHttpServer(server);
  try {
    new WebUIChannel({ router: {} as any, token, enableTrigger: false, enableWebUI: true });
    await server.start();
    const url = `http://127.0.0.1:${port}/api/setup/models/list`;
    assert.equal((await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerType: 'company-protocol' }),
    })).status, 401);

    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerType: 'company-protocol', apiKey: 'route-secret' }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json() as any;
    assert.equal(payload.error, 'Model listing is not supported for this provider type.');
    assert.equal(JSON.stringify(payload).includes('route-secret'), false);
  } finally {
    await server.stop().catch((): void => undefined);
    setHttpServer(null);
  }
});
