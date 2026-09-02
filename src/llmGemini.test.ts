import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('missing test server address'));
      else resolve(address.port);
    });
  });
}

function runChild(script: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: process.cwd(), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ stdout, stderr, code }));
  });
}

test('requestLlmOnce uses native Gemini streaming endpoint and parses its response', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-gemini-test-'));
  const capturedUrls: string[] = [];
  const capturedHeaders: http.IncomingHttpHeaders[] = [];
  const capturedBodies: any[] = [];
  const server = http.createServer((request, response) => {
    const requestIndex = capturedUrls.length;
    capturedUrls.push(request.url || '');
    capturedHeaders.push(request.headers);
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      capturedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (requestIndex === 0) {
        response.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Hello ' }] } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini' }, { functionCall: { id: 'call-1', name: 'read', args: { filePath: 'x' } } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
        })}\n\n`);
      } else {
        response.write(`data: ${JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
        })}\n\n`);
      }
      response.end();
    });
  });
  const port = await listen(server);

  const script = `
    const { requestLlmOnce } = require('./lib/llm');
    const request = (effort) => requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemPrompt: 'system',
      modelEntryOverride: {
        providerKey: 'fixture', providerType: 'gemini', model: 'gemini-3.1-pro-high',
        baseUrl: 'http://127.0.0.1:${port}/v1beta', apiKey: 'test-key',
        extraFields: {}, extraHeaders: {},
      },
      effort,
      toolDefinitions: [{ name: 'read', description: 'Read', parameters: {
        type: 'object', additionalProperties: false,
        properties: { filePath: { type: 'string' } }, required: ['filePath'],
      } }],
      notifySessionEvents: false, registerAbortController: false,
      maxRetries: 1, purpose: 'setup-test',
    });
    (async () => {
      const result = await request(undefined);
      const imageResult = await request('none');
      console.log('GEMINI_RESULT:' + JSON.stringify({ result, imageResult }));
      process.exit(0);
    })().catch(error => {
      console.error(error && error.stack || error);
      process.exit(1);
    });
  `;

  try {
    const child = await runChild(script, {
      ...process.env,
      FOXWARM_DATA_DIR: dataDir,
      FOXWARM_CONFIG_PATH: path.join(dataDir, 'state', 'config.yaml'),
    });
    assert.equal(child.code, 0, child.stderr || child.stdout);
    const marker = child.stdout.split('\n').find(line => line.startsWith('GEMINI_RESULT:'));
    assert.ok(marker, child.stdout);
    const { result, imageResult } = JSON.parse(marker!.slice('GEMINI_RESULT:'.length));

    assert.deepEqual(capturedUrls, [
      '/v1beta/models/gemini-3.1-pro-high:streamGenerateContent?alt=sse',
      '/v1beta/models/gemini-3.1-pro-high:streamGenerateContent?alt=sse',
    ]);
    assert.equal(capturedHeaders[0]['x-goog-api-key'], 'test-key');
    assert.equal(capturedHeaders[0].authorization, undefined);
    assert.deepEqual(capturedBodies[0].systemInstruction, { parts: [{ text: 'system' }] });
    assert.deepEqual(capturedBodies[0].contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
    assert.equal(capturedBodies[0].generationConfig.maxOutputTokens, 32768);
    assert.equal(capturedBodies[0].output_config, undefined);
    assert.equal(capturedBodies[0].tools[0].functionDeclarations[0].parameters.additionalProperties, undefined);
    assert.deepEqual(capturedBodies[1].generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.equal(result.text, 'Hello Gemini');
    assert.deepEqual(result.toolCalls, [{ id: 'call-1', name: 'read', args: { filePath: 'x' } }]);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 8, cachedTokens: 2, reasoningTokens: 3 });
    assert.equal(result.modelId, 'fixture/gemini-3.1-pro-high');
    assert.equal(imageResult.text, '');
    assert.deepEqual(imageResult.allParts, [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }]);
    assert.deepEqual(imageResult.usage, { inputTokens: 4, outputTokens: 1, cachedTokens: 0 });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
