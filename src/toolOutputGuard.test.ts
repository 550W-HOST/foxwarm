import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';

import { executeTools } from './llm';
import { getAgentDir } from './config';
import { read } from './tools';
import { guardToolOutputForModel, TOOL_OUTPUT_GUARD_CHAR_LIMIT } from './toolOutputGuard';
import { formatToolResponsePayload } from '../packages/shared/dist/toolResponseFormatting';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function guardOptions(sessionId = makeSessionId('tool_output_guard')) {
  return {
    sessionId,
    session: { id: sessionId, agent: 'main' },
    toolName: 'test_tool',
    toolUseId: `call_${Math.random().toString(36).slice(2, 8)}`,
    nodeId: 'master',
  };
}

async function readSaved(relativePath: string): Promise<string> {
  return fs.readFile(path.isAbsolute(relativePath) ? relativePath : path.join(getAgentDir('main'), relativePath), 'utf8');
}

test('tool output guard truncates oversized output field and preserves metadata', async () => {
  const longOutput = 'A'.repeat(TOOL_OUTPUT_GUARD_CHAR_LIMIT + 5000);
  const result = await guardToolOutputForModel({
    output: longOutput,
    fullPath: '/tmp/example.txt',
    status: 'ok',
  }, guardOptions());

  assert.equal(result.fullPath, '/tmp/example.txt');
  assert.equal(result.status, 'ok');
  assert.equal(result.outputTruncated, true);
  assert.equal(result.outputOriginalLengthChars, longOutput.length);
  assert.match(result.output, /TOOL OUTPUT TOO LONG: output field/);
  assert.match(result.output, /\[foxwarm: line too long \(/);
  assert.match(result.output, /Foxwarm placeholders above .* are not original output content/);
  assert.match(result.output, /Original output: 1 line\(s\), 45000 character\(s\)\./);
  assert.equal(path.isAbsolute(result.outputFullPath), true);
  assert.match(result.output, /Node: master/);
  assert.match(result.output, new RegExp(`Path: ${result.outputFullPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(result.output, /Use read|Tool path/i);
  assert.equal(await readSaved(result.outputFullPath), longOutput);
  assert.ok(formatToolResponsePayload(result).length < TOOL_OUTPUT_GUARD_CHAR_LIMIT);
});

test('tool output guard saved path is absolute and cwd-independent', async () => {
  const sessionId = makeSessionId('tool_output_guard_cwd');
  const cwd = path.join(getAgentDir('main'), '.temp', `tool-output-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.ensureDir(cwd);
  const content = 'CWD_INDEPENDENT_OUTPUT\n' + 'C'.repeat(TOOL_OUTPUT_GUARD_CHAR_LIMIT + 5000);

  try {
    const result = await guardToolOutputForModel({ output: content }, {
      ...guardOptions(sessionId),
      session: { id: sessionId, agent: 'main', cwd },
    });

    assert.equal(path.isAbsolute(result.outputFullPath), true);
    assert.doesNotMatch(result.output, /Use read|Tool path/i);
    const readResult = await read({ filePath: result.outputFullPath }, { session: { id: sessionId, agent: 'main', cwd } } as any);
    assert.equal(readResult, content);
  } finally {
    await fs.remove(cwd);
  }
});

test('tool output guard stage B truncates oversized non-output fields', async () => {
  const hugeNestedValue = 'B'.repeat(TOOL_OUTPUT_GUARD_CHAR_LIMIT + 7000);
  const result = await guardToolOutputForModel({
    output: 'small output',
    fullPath: '/tmp/keep-me.txt',
    huge: { nested: hugeNestedValue },
  }, guardOptions());

  assert.equal(result.truncated, true);
  assert.equal(result.fullPath, '/tmp/keep-me.txt');
  assert.equal(result.huge, undefined);
  assert.match(result.output, /TOOL OUTPUT TOO LONG: formatted tool response/);
  assert.equal(path.isAbsolute(result.fullOutputPath), true);
  const saved = await readSaved(result.fullOutputPath);
  assert.match(saved, /small output/);
  assert.ok(saved.includes(hugeNestedValue));
  assert.ok(formatToolResponsePayload(result).length < TOOL_OUTPUT_GUARD_CHAR_LIMIT);
});

test('tool output guard keeps top-level error semantics when stage B truncates', async () => {
  const result = await guardToolOutputForModel({
    error: 'E'.repeat(TOOL_OUTPUT_GUARD_CHAR_LIMIT + 1000),
    fullPath: '/tmp/error.log',
  }, guardOptions());

  assert.equal(result.truncated, true);
  assert.notEqual(result.error, undefined);
  assert.notEqual(result.error, null);
  assert.equal(result.fullPath, '/tmp/error.log');
  assert.match(String(result.error), /TOOL ERROR OUTPUT TOO LONG/);
  assert.ok(formatToolResponsePayload(result).length < TOOL_OUTPUT_GUARD_CHAR_LIMIT);
});

test('read returns full content to unified guard instead of old 10000-char truncation', async () => {
  const sessionId = makeSessionId('tool_output_guard_read');
  const relativePath = path.join('.temp', 'tool-output-guard-read', `${sessionId}.txt`);
  const fullPath = path.join(getAgentDir('main'), relativePath);
  const content = 'READ_FULL_CONTENT\n' + 'R'.repeat(TOOL_OUTPUT_GUARD_CHAR_LIMIT + 6000);
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, content, 'utf8');

  const toolMessage = await executeTools(
    [{ id: 'call_read_long', name: 'read', args: { filePath: relativePath } }],
    { sessionId, session: { id: sessionId, agent: 'main' } },
    { id: sessionId, agent: 'main', verbose: false },
  );

  const response = toolMessage.parts[0].functionResponse?.response;
  assert.equal(response.outputTruncated, true);
  assert.equal(response.outputOriginalLengthChars, content.length);
  assert.doesNotMatch(String(response.output), /Showing first 10000 chars only/);
  assert.equal(await readSaved(response.outputFullPath), content);
  assert.ok(formatToolResponsePayload(response).length < TOOL_OUTPUT_GUARD_CHAR_LIMIT);
});
