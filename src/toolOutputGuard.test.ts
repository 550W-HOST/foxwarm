import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';

import { executeTools } from './llm';
import { getAgentDir } from './config';
import * as mcpClient from './mcpClient';
import { nodesManager } from './nodes/manager';
import * as sessionManager from './sessionManager';
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

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUs8AAAAASUVORK5CYII=';

async function makeLargePngBase64(): Promise<string> {
  const data = await sharp({
    create: {
      width: 128,
      height: 128,
      channels: 3,
      background: { r: 32, g: 96, b: 192 },
    },
  }).png({ compressionLevel: 0 }).toBuffer();
  return data.toString('base64');
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

test('MCP images below and above the text guard threshold stay structured on hidden and unified call paths', async () => {
  const largePngBase64 = await makeLargePngBase64();
  assert.ok(TINY_PNG_BASE64.length < TOOL_OUTPUT_GUARD_CHAR_LIMIT);
  assert.ok(largePngBase64.length > TOOL_OUTPUT_GUARD_CHAR_LIMIT);

  const originalCallTool = mcpClient.callTool;
  (mcpClient as any).callTool = async (_server: string, tool: string) => mcpClient.normalizeMcpToolResult({
    content: tool === 'mixed_images'
      ? [
          { type: 'text', text: 'two images follow' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: TINY_PNG_BASE64,
            annotations: { audience: ['assistant'], priority: 0.5 },
          },
          {
            type: 'resource',
            resource: { uri: 'file:///details.txt', mimeType: 'text/plain', text: 'resource stays structured' },
          },
          { type: 'image', mimeType: 'image/png', data: largePngBase64 },
        ]
      : [{
          type: 'image',
          mimeType: 'image/png',
          data: tool === 'large_image' ? largePngBase64 : TINY_PNG_BASE64,
        }],
  });

  try {
    const sessionId = makeSessionId('mcp_image_guard');
    await sessionManager.getSession(sessionId);
    const toolMessage = await executeTools([
      {
        id: 'call_mcp_small_image',
        name: 'call_mcp',
        args: { server: 'fixture', tool: 'small_image', args: {} },
      },
      {
        id: 'call_tool_large_image',
        name: 'call_tool',
        args: { toolId: 'mcp:fixture/large_image', args: {} },
      },
      {
        id: 'call_tool_mixed_images',
        name: 'call_tool',
        args: { toolId: 'mcp:fixture/mixed_images', args: {} },
      },
    ], {
      sessionId,
      session: { id: sessionId, agent: 'main' },
    }, {
      id: sessionId,
      agent: 'main',
      verbose: false,
    });

    const imageParts = toolMessage.parts.filter(part => part.inlineData);
    assert.equal(imageParts.length, 4);
    assert.equal(imageParts[0].toolUseId, 'call_mcp_small_image');
    assert.equal(imageParts[0].inlineData?.data, TINY_PNG_BASE64);
    assert.equal(imageParts[1].toolUseId, 'call_tool_large_image');
    assert.equal(imageParts[1].inlineData?.data, largePngBase64);
    assert.equal(imageParts[2].toolUseId, 'call_tool_mixed_images');
    assert.equal(imageParts[2].inlineData?.data, TINY_PNG_BASE64);
    assert.deepEqual((imageParts[2].inlineData as any)?.annotations, { audience: ['assistant'], priority: 0.5 });
    assert.equal(imageParts[3].toolUseId, 'call_tool_mixed_images');
    assert.equal(imageParts[3].inlineData?.data, largePngBase64);

    const responses = toolMessage.parts
      .map(part => part.functionResponse?.response)
      .filter((response): response is Record<string, any> => !!response);
    assert.equal(responses.length, 3);
    for (const response of responses) {
      const serialized = JSON.stringify(response);
      assert.match(String(response.output), /Inline data returned by (call_mcp|call_tool)/);
      assert.doesNotMatch(serialized, /TOOL OUTPUT TOO LONG|foxwarm: line too long/i);
      assert.equal(serialized.includes(TINY_PNG_BASE64), false);
      assert.equal(serialized.includes(largePngBase64), false);
      assert.equal(response.truncated, undefined);
      assert.equal(response.outputTruncated, undefined);
    }
    assert.deepEqual(responses[2].content, [
      { type: 'text', text: 'two images follow' },
      {
        type: 'resource',
        resource: { uri: 'file:///details.txt', mimeType: 'text/plain', text: 'resource stays structured' },
      },
    ]);
  } finally {
    (mcpClient as any).callTool = originalCallTool;
  }
});

test('builtin and MCP magic-looking text stays ordinary text outside remote-node ingress', async () => {
  const sessionId = makeSessionId('magic_text_not_image');
  await sessionManager.getSession(sessionId);
  const relativePath = path.join('.temp', 'tool-output-magic-text', `${sessionId}.txt`);
  const fullPath = path.join(getAgentDir('main'), relativePath);
  const builtinMagic = `__IMAGE__:image/png:${TINY_PNG_BASE64}`;
  const mcpMagic = `__SCREENSHOT__:${TINY_PNG_BASE64}`;
  const originalCallTool = mcpClient.callTool;

  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, builtinMagic, 'utf8');
  (mcpClient as any).callTool = async () => mcpMagic;

  try {
    const toolMessage = await executeTools([
      { id: 'builtin-magic', name: 'read', args: { filePath: relativePath } },
      { id: 'hidden-mcp-magic', name: 'call_mcp', args: { server: 'fixture', tool: 'magic', args: {} } },
      { id: 'unified-mcp-magic', name: 'call_tool', args: { toolId: 'mcp:fixture/magic', args: {} } },
    ], {
      sessionId,
      session: { id: sessionId, agent: 'main' },
    }, {
      id: sessionId,
      agent: 'main',
      verbose: false,
    });

    assert.equal(toolMessage.parts.some(part => !!part.inlineData), false);
    const responses = toolMessage.parts
      .map(part => part.functionResponse?.response)
      .filter((response): response is Record<string, any> => !!response);
    assert.deepEqual(responses.map(response => response.output), [builtinMagic, mcpMagic, mcpMagic]);
  } finally {
    (mcpClient as any).callTool = originalCallTool;
    await fs.remove(fullPath);
  }
});

test('canonical remote CLI screenshots below and above the text limit become image parts before guarding', async () => {
  const largePngBase64 = await makeLargePngBase64();
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  const originalGetNode = nodesManager.getNode;
  const originalExecuteTool = nodesManager.executeTool;
  (nodesManager as any).getCurrentNode = async () => 'cli-fixture';
  (nodesManager as any).getNode = () => ({ id: 'cli-fixture', ws: {}, tools: new Set(['browse_get']) });
  (nodesManager as any).executeTool = async (_nodeId: string, _toolName: string, args: Record<string, any>) => {
    const data = args.tabId === 'large' ? largePngBase64 : TINY_PNG_BASE64;
    return {
      id: args.tabId,
      url: `https://${args.tabId}.example.test/`,
      title: args.tabId,
      output: `[Screenshot of ${args.tabId}]`,
      mimeType: 'image/png',
      sizeBytes: Buffer.byteLength(data, 'base64'),
      inlineData: { data, mimeType: 'image/png' },
    };
  };

  const sessionId = makeSessionId('cli_screenshot_guard');
  const session = await sessionManager.getSession(sessionId);
  session.currentNode = 'cli-fixture';
  await sessionManager.saveSession(sessionId);
  try {
    assert.ok(TINY_PNG_BASE64.length < TOOL_OUTPUT_GUARD_CHAR_LIMIT);
    assert.ok(largePngBase64.length > TOOL_OUTPUT_GUARD_CHAR_LIMIT);
    const toolMessage = await executeTools([
      { id: 'cli-small', name: 'browse_get', args: { tabId: 'small', screenshot: true } },
      { id: 'cli-large', name: 'browse_get', args: { tabId: 'large', screenshot: true } },
    ], {
      sessionId,
      session,
    }, session);

    const imageParts = toolMessage.parts.filter(part => part.inlineData);
    assert.equal(imageParts.length, 2);
    assert.deepEqual(imageParts.map(part => part.toolUseId), ['cli-small', 'cli-large']);
    assert.equal(imageParts[0].inlineData?.data, TINY_PNG_BASE64);
    assert.equal(imageParts[1].inlineData?.data, largePngBase64);

    const responses = toolMessage.parts
      .map(part => part.functionResponse?.response)
      .filter((response): response is Record<string, any> => !!response);
    assert.equal(responses.length, 2);
    for (const response of responses) {
      assert.equal(response.truncated, undefined);
      assert.equal(response.outputTruncated, undefined);
      assert.doesNotMatch(JSON.stringify(response), /TOOL OUTPUT TOO LONG|foxwarm: line too long/i);
      assert.equal(JSON.stringify(response).includes(TINY_PNG_BASE64), false);
      assert.equal(JSON.stringify(response).includes(largePngBase64), false);
    }
  } finally {
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('non-image MCP resources remain subject to the ordinary text output guard', async () => {
  const smallResource = mcpClient.normalizeMcpToolResult({
    content: [{
      type: 'resource',
      resource: { uri: 'file:///small.bin', mimeType: 'application/octet-stream', blob: 'small-blob' },
    }],
  });
  const smallGuarded = await guardToolOutputForModel(smallResource, guardOptions());
  assert.strictEqual(smallGuarded, smallResource);

  const largeBlob = 'B'.repeat(TOOL_OUTPUT_GUARD_CHAR_LIMIT + 5000);
  const largeResource = mcpClient.normalizeMcpToolResult({
    content: [{
      type: 'resource',
      resource: { uri: 'file:///large.bin', mimeType: 'application/octet-stream', blob: largeBlob },
    }],
  });
  const largeGuarded = await guardToolOutputForModel(largeResource, guardOptions());
  assert.equal(largeGuarded.truncated, true);
  assert.match(String(largeGuarded.output), /TOOL OUTPUT TOO LONG: formatted tool response/);
  assert.equal(JSON.stringify(largeGuarded).includes(largeBlob), false);
  assert.equal(await readSaved(largeGuarded.fullOutputPath).then(text => text.includes(largeBlob)), true);
});

test('read returns full content to unified guard instead of old 10000-char truncation', async () => {
  const sessionId = makeSessionId('tool_output_guard_read');
  await sessionManager.getSession(sessionId);
  const relativePath = path.join('.temp', 'tool-output-guard-read', `${sessionId}.txt`);
  const fullPath = path.join(getAgentDir('main'), relativePath);
  const content = Array.from({ length: 1200 }, (_, index) => `READ_FULL_CONTENT_${index + 1}_${'R'.repeat(60)}`).join('\n');
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
  const omission = String(response.output).match(/^--- \[foxwarm: (\d+) lines \(line range (\d+)-(\d+)\) omitted because (.+)\] ---$/m);
  assert.ok(omission);
  assert.match(String(response.output), /Foxwarm placeholders above \(line-range omission placeholders\) are not original output content\./);
  assert.ok(String(response.output).includes(`Omitted ${omission[1]} line(s) from original line range ${omission[2]}-${omission[3]} because ${omission[4]}.`));
  assert.match(String(response.output), /Original output: 1200 line\(s\), \d+ character\(s\)\./);
  assert.equal(await readSaved(response.outputFullPath), content);
  assert.ok(formatToolResponsePayload(response).length < TOOL_OUTPUT_GUARD_CHAR_LIMIT);
});
