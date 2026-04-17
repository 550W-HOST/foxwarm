const assert = require('assert');
const path = require('path');
const { convertToOpenAIResponsesFormat, convertToOpenAIFormat } = require('../lib/llmProviders/openai.js');
const { fixToolCalls, executeTools } = require('../lib/llm.js');

async function run() {
  const history = [
    {
      role: 'model',
      parts: [
        { functionCall: { id: 'call_empty', name: 'read', args: { filePath: 'a', startLine: 999, endLine: 1000 } } },
        { functionCall: { id: 'call_text', name: 'exec', args: { command: 'echo ok' } } },
        { functionCall: { id: 'call_obj', name: 'remote_node', args: { action: 'list' } } },
        { functionCall: { id: 'call_output_plus_meta', name: 'search_tools', args: { query: 'read' } } },
        { functionCall: { id: 'call_nested', name: 'search_tools', args: { query: 'schema' } } },
      ],
    },
    {
      role: 'tool',
      parts: [
        { functionResponse: { tool_use_id: 'call_empty', name: 'read', response: { output: '' } } },
        { functionResponse: { tool_use_id: 'call_text', name: 'exec', response: { output: 'ok' } } },
        { functionResponse: { tool_use_id: 'call_obj', name: 'remote_node', response: { nodes: [] } } },
        { functionResponse: { tool_use_id: 'call_output_plus_meta', name: 'search_tools', response: { output: 'ok', count: 2, tools: [{ name: 'read' }] } } },
        { functionResponse: { tool_use_id: 'call_nested', name: 'search_tools', response: { meta: { server: 'github', flags: ['fast'] }, tools: [{ name: 'read', inputSchema: { type: 'object' } }] } } },
        { functionResponse: { tool_use_id: 'call_result_null_error', name: 'remote_node', response: { result: 'remote ok', error: null, logs: [] } } },
      ],
    },
    {
      role: 'user',
      parts: [
        { system: 'current session ID = demo/test' },
        { text: 'follow-up' },
      ],
    },
  ];

  const fixed = fixToolCalls(history);
  assert.strictEqual(fixed.length, 3, 'user after tool should no longer get an interruption marker inserted');
  assert.strictEqual(fixed[2].role, 'user');

  const responsesItems = convertToOpenAIResponsesFormat(history);
  const responseOutputs = responsesItems.filter(item => item.type === 'function_call_output');
  assert.deepStrictEqual(
    responseOutputs.map(item => [item.call_id, item.output]),
    [
      ['call_empty', ''],
      ['call_text', 'ok'],
      ['call_obj', 'nodes: []'],
      ['call_output_plus_meta', 'output: ok\ncount: 2\ntools: [{name: read}]'],
      ['call_nested', 'meta: {server: github, flags: [fast]}\ntools: [{name: read, inputSchema: {type: object}}]'],
      ['call_result_null_error', 'result: remote ok\nerror: null\nlogs: []'],
    ],
    'responses serializer should preserve output-only shorthand while keeping keys for structured tool outputs'
  );

  const emptyOutput = responseOutputs.find(item => item.call_id === 'call_empty');
  assert.ok(emptyOutput, 'empty tool output must still emit function_call_output');
  assert.strictEqual(emptyOutput.output, '', 'empty tool output should remain empty string');

  const followUpIndex = responsesItems.findIndex(item => item.type === 'message' && item.role === 'user');
  const lastOutputIndex = responsesItems.findIndex(item => item.type === 'function_call_output' && item.call_id === 'call_result_null_error');
  assert.ok(lastOutputIndex > -1 && followUpIndex > lastOutputIndex, 'user follow-up must remain after all tool outputs');

  const chatMessages = convertToOpenAIFormat(history);
  const toolMessages = chatMessages.filter(item => item.role === 'tool');
  assert.deepStrictEqual(
    toolMessages.map(item => [item.tool_call_id, item.content]),
    [
      ['call_empty', ''],
      ['call_text', 'ok'],
      ['call_obj', 'nodes: []'],
      ['call_output_plus_meta', 'output: ok\ncount: 2\ntools: [{name: read}]'],
      ['call_nested', 'meta: {server: github, flags: [fast]}\ntools: [{name: read, inputSchema: {type: object}}]'],
      ['call_result_null_error', 'result: remote ok\nerror: null\nlogs: []'],
    ],
    'chat/completions serializer should preserve output-only shorthand while keeping keys for structured tool outputs'
  );

  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUs8AAAAASUVORK5CYII=';
  const imageHistory = [
    {
      role: 'model',
      parts: [
        { functionCall: { id: 'call_image', name: 'read', args: { filePath: 'demo.png' } } },
      ],
    },
    {
      role: 'tool',
      parts: [
        {
          toolUseId: 'call_image',
          inlineData: { mimeType: 'image/png', data: tinyPngBase64 },
          imageMeta: { imageId: 'call_image#1', mimeType: 'image/png', width: 1, height: 1, sizeBytes: Buffer.byteLength(tinyPngBase64, 'base64') },
        },
        {
          functionResponse: {
            tool_use_id: 'call_image',
            name: 'read',
            response: { output: '[Image loaded: demo.png]' },
          },
        },
      ],
    },
  ];

  const imageChatMessages = convertToOpenAIFormat(imageHistory);
  const imageToolMessage = imageChatMessages.find(item => item.role === 'tool');
  assert.ok(imageToolMessage);
  assert.match(JSON.stringify(imageToolMessage.content), /\[IMAGE: id=call_image#1, size=1x1\]/);

  const imageResponses = convertToOpenAIResponsesFormat(imageHistory);
  const imageResponseOutput = imageResponses.find(item => item.type === 'function_call_output' && item.call_id === 'call_image');
  assert.ok(imageResponseOutput);
  assert.match(JSON.stringify(imageResponseOutput.output), /\[IMAGE: id=call_image#1, size=1x1\]/);

  const toolResultMessage = await executeTools(
    [
      {
        id: 'call_current_alias',
        name: 'read',
        args: {
          filePath: path.join(__dirname, '..', 'package.json'),
          node: 'current',
          startLine: 200,
          endLine: 220,
        },
      },
    ],
    { sessionId: 'coder/test-node-current-alias', session: { agent: 'coder' } },
    { verbose: false }
  );

  assert.strictEqual(toolResultMessage.role, 'tool');
  assert.strictEqual(toolResultMessage.parts[0].functionResponse.tool_use_id, 'call_current_alias');
  assert.deepStrictEqual(
    toolResultMessage.parts[0].functionResponse.response,
    { output: '' },
    'node:"current" should resolve to current session node instead of causing Node not found'
  );

  console.log('llmToolSerializationTest: ok');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
