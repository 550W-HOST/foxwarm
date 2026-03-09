const assert = require('assert');
const path = require('path');
const {
  convertToOpenAIResponsesFormat,
  convertToOpenAIFormat,
  fixToolCalls,
  executeTools,
} = require('../lib/llm.js');

async function run() {
  const history = [
    {
      role: 'model',
      parts: [
        { functionCall: { id: 'call_empty', name: 'read', args: { filePath: 'a', startLine: 999, endLine: 1000 } } },
        { functionCall: { id: 'call_text', name: 'exec', args: { command: 'echo ok' } } },
        { functionCall: { id: 'call_obj', name: 'remote_node', args: { action: 'list' } } },
      ],
    },
    {
      role: 'tool',
      parts: [
        { functionResponse: { tool_use_id: 'call_empty', name: 'read', response: { output: '' } } },
        { functionResponse: { tool_use_id: 'call_text', name: 'exec', response: { output: 'ok' } } },
        { functionResponse: { tool_use_id: 'call_obj', name: 'remote_node', response: { nodes: [] } } },
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
  assert.strictEqual(fixed.length, 4, 'user after tool should get interruption assistant message inserted');
  assert.strictEqual(fixed[2].role, 'model');
  assert.strictEqual(fixed[2].parts[0].text, '[interrupted by user/system event]');

  const responsesItems = convertToOpenAIResponsesFormat(history);
  const responseOutputs = responsesItems.filter(item => item.type === 'function_call_output');
  assert.deepStrictEqual(
    responseOutputs.map(item => [item.call_id, item.output]),
    [
      ['call_empty', ''],
      ['call_text', 'ok'],
      ['call_obj', '{\n  "nodes": []\n}'],
    ],
    'responses serializer should preserve empty, text, and object tool outputs in order'
  );

  const emptyOutput = responseOutputs.find(item => item.call_id === 'call_empty');
  assert.ok(emptyOutput, 'empty tool output must still emit function_call_output');
  assert.strictEqual(emptyOutput.output, '', 'empty tool output should remain empty string');

  const followUpIndex = responsesItems.findIndex(item => item.type === 'message' && item.role === 'user');
  const lastOutputIndex = responsesItems.findIndex(item => item.type === 'function_call_output' && item.call_id === 'call_obj');
  assert.ok(lastOutputIndex > -1 && followUpIndex > lastOutputIndex, 'user follow-up must remain after all tool outputs');

  const chatMessages = convertToOpenAIFormat(history);
  const toolMessages = chatMessages.filter(item => item.role === 'tool');
  assert.deepStrictEqual(
    toolMessages.map(item => [item.tool_call_id, item.content]),
    [
      ['call_empty', ''],
      ['call_text', 'ok'],
      ['call_obj', '{\n  "nodes": []\n}'],
    ],
    'chat/completions serializer should preserve empty, text, and object tool outputs in order'
  );

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
