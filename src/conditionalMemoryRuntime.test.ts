import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { PassThrough } from 'node:stream';

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-conditional-runtime-'));
process.env.FOXWARM_DATA_DIR = DATA_ROOT;
fs.ensureDirSync(path.join(DATA_ROOT, 'state'));
fs.writeFileSync(path.join(DATA_ROOT, 'state', 'models.yaml'), `
default: alias
providers:
  leafA:
    providerType: openai-completions
    baseUrl: https://leaf-a.test/v1
    apiKey: a-secret
    models: [astra]
  leafB:
    providerType: openai-completions
    baseUrl: https://leaf-b.test/v1
    apiKey: b-secret
    models: [beta]
  alias:
    providerType: session-hash
    targets: [leafA/astra]
  failover:
    providerType: failover
    targets: [leafA/astra, leafB/beta]
    failureThreshold: 1
`, 'utf8');

after(async () => fs.remove(DATA_ROOT));

let modulesPromise: Promise<{
  llm: typeof import('./llm');
  config: typeof import('./config');
  journal: typeof import('./llmRequestJournal');
  btw: typeof import('./btw');
  agentMetadata: typeof import('./session/agentMetadata');
}> | undefined;

async function loadModules() {
  modulesPromise ||= Promise.all([
    import('./llm'),
    import('./config'),
    import('./llmRequestJournal'),
    import('./btw'),
    import('./session/agentMetadata'),
  ]).then(([llm, config, journal, btw, agentMetadata]) => ({ llm, config, journal, btw, agentMetadata }));
  return modulesPromise;
}

function makeChatStream(text: string): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function makeSession(id: string, model: string, snapshot = ''): any {
  return {
    id,
    agent: id.split('/')[0],
    history: [{ role: 'user', parts: [{ text: 'hello' }] }],
    persistentMemorySnapshot: snapshot,
    promptCacheKey: '11111111-2222-3333-4444-555555555555',
    model,
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  };
}

function makeEffects(session: any, placement: 'local' | 'session-worker', persist: () => Promise<void>): any {
  return {
    placement,
    appendMessage: async (_session: any, message: any) => { session.history.push(message); },
    persistSession: persist,
    notifySessionEvent: () => {},
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async () => false,
  };
}

function systemText(body: any): string {
  return body.messages.find((message: any) => message.role === 'system')?.content || '';
}

test('authoritative alias requests materialize the selected concrete snapshot once and reuse exact bytes', async () => {
  const { llm, config, journal } = await loadModules();
  const agentName = 'runtime-authoritative';
  const memoryDir = config.getAgentMemoryDir(agentName);
  const memoryFile = path.join(memoryDir, 'MEMORY.md');
  await fs.ensureDir(memoryDir);
  await fs.writeFile(memoryFile, [
    'common',
    '<foxwarm-if model-id="leafA/*">',
    'astra-only',
    '</foxwarm-if>',
    '<foxwarm-if model-id="leafB/*">',
    'beta-only',
    '</foxwarm-if>',
  ].join('\n'), 'utf8');

  const session = makeSession(`${agentName}/main`, 'alias', 'legacy markerless snapshot');
  let persists = 0;
  const bodies: any[] = [];
  const originalPost = axios.post;
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('ok') };
  };
  try {
    const first = await llm.chat(null, session, 0, {
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      currentSessionEffects: makeEffects(session, 'local', async () => { persists += 1; }),
    });
    const firstSnapshot = session.persistentMemorySnapshot;
    assert.match(firstSnapshot, /^<foxwarm-current-model model-id="leafA\/astra" \/>\n\n/);
    assert.match(firstSnapshot, /astra-only/);
    assert.doesNotMatch(firstSnapshot, /beta-only|<foxwarm-if/);
    assert.equal(systemText(bodies[0]), firstSnapshot);
    assert.equal(persists, 1);
    assert.equal(session.promptCacheKey, '11111111-2222-3333-4444-555555555555');

    await fs.remove(memoryFile);
    const second = await llm.chat(null, session, 1, {
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      currentSessionEffects: makeEffects(session, 'local', async () => { persists += 1; }),
    });
    assert.equal(session.persistentMemorySnapshot, firstSnapshot);
    assert.equal(systemText(bodies[1]), firstSnapshot);
    assert.equal(persists, 1);

    for (const result of [first, second]) {
      const reconstructed = await journal.reconstructLlmRequest(result.llmRequestId!);
      assert.equal(reconstructed.completeness, 'complete');
      if (reconstructed.completeness === 'complete') {
        assert.equal(reconstructed.systemPrompt, firstSnapshot);
        assert.equal(reconstructed.attempts[0].systemPrompt, firstSnapshot);
      }
    }
  } finally {
    (axios as any).post = originalPost;
  }
});

test('authoritative persistence failure restores the old snapshot and prevents provider send', async () => {
  const { llm, config } = await loadModules();
  const agentName = 'runtime-persist-failure';
  await fs.ensureDir(config.getAgentMemoryDir(agentName));
  await fs.writeFile(path.join(config.getAgentMemoryDir(agentName), 'MEMORY.md'), 'memory', 'utf8');
  const oldSnapshot = 'old markerless snapshot';
  const session = makeSession(`${agentName}/main`, 'alias', oldSnapshot);
  let sends = 0;
  const originalPost = axios.post;
  (axios as any).post = async () => { sends += 1; throw new Error('provider must not run'); };
  try {
    await assert.rejects(() => llm.chat(null, session, 0, {
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      currentSessionEffects: makeEffects(session, 'local', async () => { throw new Error('persist failed'); }),
    }), /persist failed/);
    assert.equal(sends, 0);
    assert.equal(session.persistentMemorySnapshot, oldSnapshot);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('session-worker effects persist authoritative concrete snapshots through the same boundary', async () => {
  const { llm, config } = await loadModules();
  const agentName = 'runtime-worker';
  await fs.ensureDir(config.getAgentMemoryDir(agentName));
  await fs.writeFile(path.join(config.getAgentMemoryDir(agentName), 'MEMORY.md'), '<foxwarm-if model-id="leafB/*">\nworker-beta\n</foxwarm-if>', 'utf8');
  const session = makeSession(`${agentName}/main`, 'leafB/beta');
  let persistedSnapshot = '';
  const originalPost = axios.post;
  (axios as any).post = async (_url: string, body: any) => {
    assert.match(systemText(body), /worker-beta/);
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('worker ok') };
  };
  try {
    await llm.chat(null, session, 0, {
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      currentSessionEffects: makeEffects(session, 'session-worker', async () => { persistedSnapshot = session.persistentMemorySnapshot; }),
    });
    assert.equal(persistedSnapshot, session.persistentMemorySnapshot);
    assert.match(persistedSnapshot, /^<foxwarm-current-model model-id="leafB\/beta" \/>/);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('detached BTW snapshots rebuild custom sources locally without mutating or persisting the owner', async () => {
  const { llm, config, btw } = await loadModules();
  const agentName = 'runtime-detached';
  const agentDir = config.getAgentDir(agentName);
  const custom = path.join(agentDir, 'custom.md');
  await fs.ensureDir(agentDir);
  await fs.writeFile(custom, '<foxwarm-if model-id="leafB/*">\ndetached-beta\n</foxwarm-if>', 'utf8');
  const source = makeSession(`${agentName}/main`, 'leafB/beta', '<foxwarm-current-model model-id="leafA/astra" />\n\nold');
  source.systemPromptFiles = ['custom.md'];
  const snapshot = btw.cloneSessionForBtw(source);
  const originalPost = axios.post;
  (axios as any).post = async (_url: string, body: any) => {
    assert.match(systemText(body), /detached-beta/);
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('detached ok') };
  };
  try {
    await llm.chat(null, snapshot, 0, {
      appendMessage: async message => { snapshot.history.push(message); },
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      snapshotAuthority: 'detached',
      currentSessionEffects: makeEffects(snapshot, 'local', async () => { throw new Error('detached snapshot persisted'); }),
    });
    assert.equal(source.persistentMemorySnapshot, '<foxwarm-current-model model-id="leafA/astra" />\n\nold');
    assert.match(snapshot.persistentMemorySnapshot, /^<foxwarm-current-model model-id="leafB\/beta" \/>/);
    assert.match(snapshot.persistentMemorySnapshot, /detached-beta/);
    assert.deepEqual(snapshot.systemPromptFiles, ['custom.md']);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('failover resolves prompts per selected leaf and journals one request with exact attempt prompts', async () => {
  const { llm, journal } = await loadModules();
  const prompts: string[] = [];
  const bodies: any[] = [];
  const originalPost = axios.post;
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) throw new Error('force failover');
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('fallback ok') };
  };
  try {
    const result = await llm.requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'fail over' }] }],
      systemPrompt: 'unused', model: 'failover', promptCacheKey: 'same-cache-key', maxRetries: 2,
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      resolveSystemPromptForModel: async (modelId: string) => {
        prompts.push(modelId);
        return `<foxwarm-current-model model-id="${modelId}" />\n\nprompt for ${modelId}`;
      },
    } as any);
    assert.deepEqual(prompts, ['leafA/astra', 'leafB/beta']);
    assert.match(systemText(bodies[0]), /prompt for leafA\/astra/);
    assert.match(systemText(bodies[1]), /prompt for leafB\/beta/);
    const reconstructed = await journal.reconstructLlmRequest(result.llmRequestId!);
    assert.equal(reconstructed.completeness, 'complete');
    if (reconstructed.completeness === 'complete') {
      assert.equal(reconstructed.attempts.length, 2);
      assert.match(reconstructed.systemPrompt, /leafA\/astra/);
      assert.match(reconstructed.attempts[0].systemPrompt, /leafA\/astra/);
      assert.match(reconstructed.attempts[1].systemPrompt, /leafB\/beta/);
    }
  } finally {
    (axios as any).post = originalPost;
  }
});

test('lifecycle refreshes reuse recorded concrete identity and defer never-materialized virtual sessions', async () => {
  const { llm, config, agentMetadata } = await loadModules();
  const agentName = 'runtime-refresh';
  const memoryDir = config.getAgentMemoryDir(agentName);
  await fs.ensureDir(memoryDir);
  await fs.writeFile(path.join(memoryDir, 'MEMORY.md'), '<foxwarm-if model-id="leafB/*">\nrefresh-beta\n</foxwarm-if>', 'utf8');

  const virtual = makeSession(`${agentName}/virtual`, 'alias', '');
  assert.equal(llm.resolveConcreteModelIdForSnapshot('alias'), undefined);
  assert.equal(await llm.buildSessionSystemPromptSnapshotForSession(virtual), undefined);
  let virtualPersists = 0;
  await agentMetadata.refreshSessionSnapshotForSession(virtual, async () => { virtualPersists += 1; });
  assert.equal(virtual.persistentMemorySnapshot, '');
  assert.equal(virtualPersists, 0);

  const recorded = makeSession(`${agentName}/recorded`, 'alias', '<foxwarm-current-model model-id="leafB/beta" />\n\nstale');
  let recordedPersists = 0;
  await agentMetadata.refreshSessionSnapshotForSession(recorded, async () => { recordedPersists += 1; });
  assert.equal(llm.resolveSessionSnapshotModelId(recorded), 'leafB/beta');
  assert.match(recorded.persistentMemorySnapshot, /refresh-beta/);
  assert.equal(recordedPersists, 1);
});
