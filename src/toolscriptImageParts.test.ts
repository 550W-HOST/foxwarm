import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { executeTools } from './llm';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import * as tools from './tools';
import { getAgentDir } from './config';
import { hydrateMessagesForProvider, putImageBlob, resolveImageBlobPath } from './imageBlobs';
import { normalizeToolResultImages } from './toolImages';
import { resetToolScriptRunsForTests, tool_run_script } from './toolscript';
import type { InlineDataRef, MessagePart } from './types';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function writeScript(fileName: string, content: string): Promise<string> {
  const agentDir = getAgentDir('main');
  await fs.ensureDir(agentDir);
  const fullPath = path.join(agentDir, fileName);
  await fs.writeFile(fullPath, content, 'utf8');
  return fullPath;
}

function asMain(body: string): string {
  return [
    'def main(args):',
    ...body.split('\n').map(line => line ? `    ${line}` : ''),
    '',
  ].join('\n');
}

async function makePng(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: rgb } }).png().toBuffer();
}

async function storePng(buffer: Buffer, imageId: string, width: number, height: number): Promise<InlineDataRef> {
  return putImageBlob({ buffer, mimeType: 'image/png', imageId, width, height });
}

function imagePart(ref: InlineDataRef): MessagePart {
  return {
    inlineDataRef: ref,
    imageMeta: { imageId: ref.imageId, mimeType: ref.mimeType, width: ref.width, height: ref.height, sizeBytes: ref.byteLength, sha256: ref.sha256 },
  };
}

function responseParts(toolMessage: any): any {
  const part = toolMessage.parts.find((entry: MessagePart) => entry.functionResponse);
  return part?.functionResponse?.response;
}

test('normalizeToolResultImages accepts canonical image parts that reference stored bytes', async () => {
  const buffer = await makePng(9, 7, { r: 12, g: 120, b: 208 });
  const ref = await storePng(buffer, 'ig_probe', 9, 7);
  try {
    const normalized = await normalizeToolResultImages(
      { output: 'script output', imageParts: [imagePart(ref)] },
      'call_boundary',
      '[Inline data returned by run_script]',
    );

    assert.equal(normalized.imageParts.length, 1);
    const part = normalized.imageParts[0];
    assert.equal(part.toolUseId, 'call_boundary');
    assert.equal(part.imageMeta?.imageId, 'call_boundary#1');
    assert.equal(part.imageMeta?.mimeType, 'image/png');
    assert.equal(part.imageMeta?.width, 9);
    assert.equal(part.imageMeta?.height, 7);
    assert.equal(part.imageMeta?.sizeBytes, buffer.length);
    assert.equal(part.imageMeta?.sha256, ref.sha256);
    assert.deepEqual(part.inlineDataRef, ref);
    assert.equal(part.inlineData, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(normalized.result, 'imageParts'), false);
    assert.equal(normalized.result.output, 'script output');
    assert.equal(JSON.stringify(normalized).includes(buffer.toString('base64')), false);
  } finally {
    await fs.remove(resolveImageBlobPath(ref.blobId!));
  }
});

test('ordinary JSON is never mistaken for a stored image reference', async () => {
  const results: any[] = [
    { output: 'plain', imageParts: [{ inlineDataRef: { blobId: 'not-a-blob', mimeType: 'image/png', byteLength: 4, sha256: 'a'.repeat(64) } }] },
    { output: 'plain', imageParts: [{ inlineDataRef: { blobId: `${'b'.repeat(64)}.png`, mimeType: 'text/plain', byteLength: 4, sha256: 'b'.repeat(64) } }] },
    { output: 'plain', imageParts: [{ inlineDataRef: { blobId: `${'c'.repeat(64)}.png`, mimeType: 'image/png', byteLength: 4, sha256: 'not-a-digest' } }] },
    { output: 'plain', imageParts: [{ blobId: `${'d'.repeat(64)}.png`, mimeType: 'image/png' }] },
    { output: 'plain', parts: [{ text: 'ordinary' }] },
  ];

  for (const result of results) {
    const normalized = await normalizeToolResultImages(result, 'call_plain', '[fallback]');
    assert.deepEqual(normalized.imageParts, []);
    assert.strictEqual(normalized.result, result);
  }
});

test('request_model_without_context keeps the text result and exposes canonical parts', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_parts_text');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain('return request_model_without_context("ping")'));

  const session = await sessionManager.getSession(sessionId);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({ text: 'pong', toolCalls: [] as any[] });

  try {
    const result = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { text: 'pong', parts: [] });
    assert.equal((result as any).imageParts, undefined);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('a script-returned image reaches the tool result and the session as a Blob reference', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_image');
  const scriptName = `${makeId('script')}.py`;
  const toolCallId = 'call_script_image';
  await writeScript(scriptName, asMain('return request_model_without_context("draw a small fox")'));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(9, 7, { r: 12, g: 120, b: 208 });
  const ref = await storePng(png, 'ig_script_one', 9, 7);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({ text: '', allParts: [imagePart(ref)], toolCalls: [] as any[] });

  try {
    const raw = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(raw.status, 'completed');
    assert.equal((raw as any).imageParts?.length, 1);
    assert.deepEqual((raw as any).imageParts[0].inlineDataRef, ref);
    assert.deepEqual(raw.result, { text: '', parts: '[1 image part(s) promoted]' });
    assert.equal(JSON.stringify(raw).includes(png.toString('base64')), false);

    const toolMessage = await executeTools([
      { id: toolCallId, name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);

    const imageParts = toolMessage.parts.filter(part => part.inlineDataRef);
    assert.equal(imageParts.length, 1);
    assert.equal(imageParts[0].toolUseId, toolCallId);
    assert.equal(imageParts[0].imageMeta?.imageId, `${toolCallId}#1`);
    assert.deepEqual(imageParts[0].inlineDataRef, ref);
    assert.equal(imageParts[0].inlineData, undefined);

    const response = responseParts(toolMessage);
    assert.equal(response.status, 'completed');
    assert.equal(response.imageParts, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(response.result, 'parts'), true);
    assert.equal(response.result.parts, '[1 image part(s) promoted]');
    assert.equal(JSON.stringify(toolMessage).includes(png.toString('base64')), false);

    // The provider boundary restores the bytes from the reference, so the next
    // model request sees the exact script-produced image.
    const hydrated = await hydrateMessagesForProvider([toolMessage]);
    const hydratedPart = hydrated[0].parts.find(part => part.inlineData);
    assert.ok(hydratedPart?.inlineData);
    assert.equal(hydratedPart!.inlineData!.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(hydratedPart!.inlineData!.data, 'base64'), png);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
    await fs.remove(resolveImageBlobPath(ref.blobId!));
  }
});

test('returning the one-shot result object promotes its image parts', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_envelope');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain([
    'result = request_model_without_context("draw a fox")',
    'return result',
  ].join('\n')));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(9, 7, { r: 12, g: 120, b: 208 });
  const ref = await storePng(png, 'ig_envelope', 9, 7);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({ text: '', allParts: [imagePart(ref)], toolCalls: [] as any[] });

  try {
    const toolMessage = await executeTools([
      { id: 'call_envelope', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);

    const imageParts = toolMessage.parts.filter(part => part.inlineDataRef);
    assert.equal(imageParts.length, 1);
    assert.equal(imageParts[0].imageMeta?.imageId, 'call_envelope#1');
    assert.deepEqual(imageParts[0].inlineDataRef, ref);
    assert.equal(JSON.stringify(toolMessage).includes(png.toString('base64')), false);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
    await fs.remove(resolveImageBlobPath(ref.blobId!));
  }
});

test('returning an object that carries the one-shot parts promotes its image parts', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_parts_only');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain([
    'result = request_model_without_context("draw a fox")',
    'return {"parts": result["parts"]}',
  ].join('\n')));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(4, 3, { r: 208, g: 52, b: 12 });
  const ref = await storePng(png, 'ig_parts_only', 4, 3);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({ text: 'ignored text', allParts: [imagePart(ref)], toolCalls: [] as any[] });

  try {
    const toolMessage = await executeTools([
      { id: 'call_parts_only', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);

    const imageParts = toolMessage.parts.filter(part => part.inlineDataRef);
    assert.equal(imageParts.length, 1);
    assert.equal(imageParts[0].imageMeta?.imageId, 'call_parts_only#1');
    assert.deepEqual(imageParts[0].inlineDataRef, ref);
    assert.equal(responseParts(toolMessage).result.parts, '[1 image part(s) promoted]');
    assert.equal(JSON.stringify(toolMessage).includes(png.toString('base64')), false);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
    await fs.remove(resolveImageBlobPath(ref.blobId!));
  }
});

test('promoting an inline image keeps unrelated parts JSON untouched', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_inline_parts');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain([
    'return {',
    '    "inlineData": {"data": args["data"], "mimeType": "image/png"},',
    '    "parts": [{"text": "KEEP_ME"}, {"note": "ordinary json"}],',
    '    "status": "kept",',
    '}',
  ].join('\n')));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(5, 2, { r: 32, g: 96, b: 192 });
  try {
    const toolMessage = await executeTools([
      { id: 'call_inline_parts', name: 'run_script', args: { filePath: scriptName, args: { data: png.toString('base64') } } },
    ], { sessionId, session }, session);

    const response = responseParts(toolMessage);
    assert.deepEqual(response.result.parts, [{ text: 'KEEP_ME' }, { note: 'ordinary json' }]);
    assert.equal(response.result.status, 'kept');
    assert.match(String(response.result.inlineData), /^\[image promoted, mimeType=image\/png\]$/);
    const imageParts = toolMessage.parts.filter(part => part.inlineData);
    assert.equal(imageParts.length, 1);
    assert.equal(imageParts[0].imageMeta?.imageId, 'call_inline_parts#1');
    assert.equal(toolMessage.parts.filter(part => part.inlineDataRef).length, 0);
  } finally {
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('promoting inlineDataItems keeps unrelated parts JSON untouched', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_inline_items');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain([
    'return {',
    '    "inlineDataItems": [{"data": args["data"], "mimeType": "image/png"}],',
    '    "parts": [{"text": "KEEP_ME_TOO"}],',
    '}',
  ].join('\n')));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(6, 4, { r: 96, g: 32, b: 192 });
  try {
    const toolMessage = await executeTools([
      { id: 'call_inline_items', name: 'run_script', args: { filePath: scriptName, args: { data: png.toString('base64') } } },
    ], { sessionId, session }, session);

    const response = responseParts(toolMessage);
    assert.deepEqual(response.result.parts, [{ text: 'KEEP_ME_TOO' }]);
    assert.equal(response.result.inlineDataItems, '[1 image(s) promoted]');
    const imageParts = toolMessage.parts.filter(part => part.inlineData);
    assert.equal(imageParts.length, 1);
    assert.equal(imageParts[0].imageMeta?.imageId, 'call_inline_items#1');
  } finally {
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('a one-shot part carrying both text and an image reference keeps both', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_dual_field');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain('return request_model_without_context("draw and label")'));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(4, 3, { r: 12, g: 120, b: 208 });
  const ref = await storePng(png, 'ig_dual_field', 4, 3);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({
    text: 'here is a fox',
    allParts: [{ text: 'here is a fox', inlineDataRef: ref }],
    toolCalls: [] as any[],
  });

  try {
    const raw = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(raw.status, 'completed', String(raw.error));
    assert.equal((raw as any).imageParts?.length, 1);
    assert.equal((raw as any).imageParts[0].text, 'here is a fox');
    assert.deepEqual((raw as any).imageParts[0].inlineDataRef, ref);
    assert.deepEqual(raw.result, { text: 'here is a fox', parts: [{ text: 'here is a fox' }, '[1 image part(s) promoted]'] });

    const toolMessage = await executeTools([
      { id: 'call_dual_field', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);
    const imageParts = toolMessage.parts.filter(part => part.inlineDataRef);
    assert.equal(imageParts.length, 1);
    assert.deepEqual(imageParts[0].inlineDataRef, ref);
    assert.equal(responseParts(toolMessage).result.text, 'here is a fox');
    assert.deepEqual(responseParts(toolMessage).result.parts, [{ text: 'here is a fox' }, '[1 image part(s) promoted]']);
    assert.equal(JSON.stringify(toolMessage).includes(png.toString('base64')), false);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
    await fs.remove(resolveImageBlobPath(ref.blobId!));
  }
});

test('text plus image returns keep the text and promote only the image parts', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_mixed');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain('return request_model_without_context("describe and draw")'));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(4, 3, { r: 208, g: 52, b: 12 });
  const ref = await storePng(png, 'ig_script_mixed', 4, 3);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({
    text: 'here is a fox',
    allParts: [{ text: 'here is a fox' }, imagePart(ref)],
    toolCalls: [] as any[],
  });

  try {
    const raw = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(raw.status, 'completed');
    assert.equal((raw as any).imageParts?.length, 1);
    assert.deepEqual(raw.result, { text: 'here is a fox', parts: [{ text: 'here is a fox' }, '[1 image part(s) promoted]'] });

    const toolMessage = await executeTools([
      { id: 'call_script_mixed', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);
    assert.equal(toolMessage.parts.filter(part => part.inlineDataRef).length, 1);
    assert.equal(responseParts(toolMessage).result.text, 'here is a fox');
    assert.equal(JSON.stringify(toolMessage).includes(png.toString('base64')), false);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
    await fs.remove(resolveImageBlobPath(ref.blobId!));
  }
});

test('multiple script images keep their order and distinct references', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_multi');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain('return request_model_without_context("draw two")'));

  const session = await sessionManager.getSession(sessionId);
  const first = await makePng(4, 3, { r: 12, g: 120, b: 208 });
  const second = await makePng(6, 5, { r: 208, g: 52, b: 12 });
  const firstRef = await storePng(first, 'ig_script_first', 4, 3);
  const secondRef = await storePng(second, 'ig_script_second', 6, 5);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({
    text: '',
    allParts: [imagePart(firstRef), imagePart(secondRef)],
    toolCalls: [] as any[],
  });

  try {
    const toolMessage = await executeTools([
      { id: 'call_script_multi', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);

    const imageParts = toolMessage.parts.filter(part => part.inlineDataRef);
    assert.equal(imageParts.length, 2);
    assert.deepEqual(imageParts.map(part => part.imageMeta?.imageId), ['call_script_multi#1', 'call_script_multi#2']);
    assert.deepEqual(imageParts.map(part => part.inlineDataRef?.blobId), [firstRef.blobId, secondRef.blobId]);
    assert.deepEqual(imageParts.map(part => part.imageMeta?.width), [4, 6]);
    assert.equal(JSON.stringify(toolMessage).includes(first.toString('base64')), false);
    assert.equal(JSON.stringify(toolMessage).includes(second.toString('base64')), false);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
    await fs.remove(resolveImageBlobPath(firstRef.blobId!));
    await fs.remove(resolveImageBlobPath(secondRef.blobId!));
  }
});

test('a missing stored image fails the tool result explicitly instead of leaving a dangling reference', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_missing');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain('return request_model_without_context("draw then lose the blob")'));

  const session = await sessionManager.getSession(sessionId);
  const missingRef: InlineDataRef = {
    imageId: 'ig_script_missing',
    blobId: `${'e'.repeat(64)}.png`,
    mimeType: 'image/png',
    byteLength: 128,
    sha256: 'e'.repeat(64),
  };
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  (llm as any).requestLlmOnce = async () => ({ text: '', allParts: [imagePart(missingRef)], toolCalls: [] as any[] });

  try {
    const toolMessage = await executeTools([
      { id: 'call_script_missing', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);

    assert.equal(toolMessage.parts.filter(part => part.inlineDataRef).length, 0);
    const response = responseParts(toolMessage);
    assert.match(String(response.error || ''), /ENOENT|no such file/i);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('ordinary JSON returned by a script stays ordinary JSON', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_json');
  const scriptName = `${makeId('script')}.py`;
  await writeScript(scriptName, asMain('return {"parts": [{"inlineDataRef": {"blobId": "not-a-blob"}}], "text": "plain"}'));
  const session = await sessionManager.getSession(sessionId);

  try {
    const raw = await tool_run_script({ filePath: scriptName }, { sessionId, session });
    assert.equal(raw.status, 'completed');
    assert.equal((raw as any).imageParts, undefined);
    assert.deepEqual(raw.result, { parts: [{ inlineDataRef: { blobId: 'not-a-blob' } }], text: 'plain' });

    const toolMessage = await executeTools([
      { id: 'call_script_json', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);
    assert.equal(toolMessage.parts.filter(part => part.inlineDataRef).length, 0);
    assert.deepEqual(responseParts(toolMessage).result, { parts: [{ inlineDataRef: { blobId: 'not-a-blob' } }], text: 'plain' });
  } finally {
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
  }
});

test('a script-produced image can be saved through the existing image id lookup', async () => {
  await resetToolScriptRunsForTests();
  const sessionId = makeId('toolscript_save');
  const scriptName = `${makeId('script')}.py`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-toolscript-image-'));
  await writeScript(scriptName, asMain('return request_model_without_context("draw a fox")'));

  const session = await sessionManager.getSession(sessionId);
  const png = await makePng(9, 7, { r: 12, g: 120, b: 208 });
  const ref = await storePng(png, 'ig_script_saved', 9, 7);
  const originalRequestLlmOnce = (llm as any).requestLlmOnce;
  const originalGetExistingSession = sessionManager.getExistingSession;
  const originalGetArchivedMessages = sessionManager.getArchivedMessages;
  (llm as any).requestLlmOnce = async () => ({ text: '', allParts: [imagePart(ref)], toolCalls: [] as any[] });

  try {
    const toolMessage = await executeTools([
      { id: 'call_script_saved', name: 'run_script', args: { filePath: scriptName } },
    ], { sessionId, session }, session);

    (sessionManager as any).getExistingSession = async () => ({ id: sessionId, agent: 'main', cwd: tempDir, history: [toolMessage] });
    (sessionManager as any).getArchivedMessages = async () => ({ records: [] as any[] });

    const saved = await tools.image_write_to_file({
      id: 'call_script_saved#1',
      filePath: 'script-image.png',
      overwrite: true,
    }, { sessionId, session: { id: sessionId, agent: 'main', cwd: tempDir } } as any);

    const writtenPath = path.join(tempDir, 'script-image.png');
    assert.equal(await fs.pathExists(writtenPath), true);
    assert.deepEqual(await fs.readFile(writtenPath), png);
    const metadata = await sharp(writtenPath).metadata();
    assert.equal(metadata.width, 9);
    assert.equal(metadata.height, 7);
    assert.match(String(saved), /send_file/);
  } finally {
    (llm as any).requestLlmOnce = originalRequestLlmOnce;
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).getArchivedMessages = originalGetArchivedMessages;
    await resetToolScriptRunsForTests();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(path.join(getAgentDir('main'), scriptName)).catch(() => false);
    await fs.remove(resolveImageBlobPath(ref.blobId!));
    await fs.remove(tempDir);
  }
});
