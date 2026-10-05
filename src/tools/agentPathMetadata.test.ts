import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { getAgentDir } from '../config';
import * as sessionManager from '../sessionManager';
import * as nodeExecution from '../nodeExecution';
import { executeTools, convertToAnthropicFormat } from '../llm';
import { readSessionHistorySnapshot } from '../session/metadataStore';
import { executeResolvedTool, type ResolvedTool } from './resolvedTools';
import { RESOLVED_PATH_SIDECAR } from '../../packages/shared/dist/resolvedPathMetadata';
import { convertToOpenAIFormat, convertToOpenAIResponsesFormat } from '../llmProviders/openai';

test('successful native file batch records per-call paths outside model response and persists them', async () => {
  const id = `agent_path_meta_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const session = await sessionManager.getSession(id);
  session.agent = 'main'; session.currentNode = 'master';
  const dir = path.join(getAgentDir('main'), 'tmp', id);
  await fs.ensureDir(dir);
  session.cwd = dir;
  await fs.writeFile(path.join(dir, 'first.txt'), 'first');
  try {
    const message = await executeTools([
      { id: 'read-relative', name: 'read', args: { filePath: 'first.txt', startLine: 1 } },
      { id: 'patch-two', name: 'apply_patch', args: { input: '*** Begin Patch\n*** Add File: $fw_tmp/' + id + '/second.txt\n+second\n*** Add File: $fw_tmp/' + id + '/third.txt\n+third\n*** End Patch' } },
      { id: 'read-error', name: 'read', args: { filePath: '$unknown/missing' } },
    ], { sessionId: id, session }, session);
    const responses = message.parts.filter(part => part.functionResponse).map(part => part.functionResponse!);
    assert.deepEqual(responses.map(item => item.tool_use_id), ['read-relative', 'patch-two', 'read-error']);
    assert.deepEqual(responses[0].__meta?.resolvedPaths, [{ raw: 'first.txt', resolved: path.join(dir, 'first.txt'), nodeId: 'master' }]);
    assert.deepEqual(responses[1].__meta?.resolvedPaths, ['second.txt', 'third.txt'].map(name => ({ raw: `$fw_tmp/${id}/${name}`, resolved: path.join(dir, name), nodeId: 'master' })));
    assert.equal(responses[2].__meta, undefined);
    assert.match(String(responses[2].response.error), /Unknown Agent path variable/);
    assert.doesNotMatch(JSON.stringify(responses.map(item => item.response)), /resolvedPaths|__foxwarmResolvedToolPaths/);
    session.history.push(message);
    await sessionManager.saveSession(id);
    const saved = await readSessionHistorySnapshot(id);
    assert.deepEqual(saved?.history.at(-1).parts[1].functionResponse.__meta, responses[1].__meta);
    const anth = convertToAnthropicFormat([message], { providerType: 'anthropic' } as any);
    const chat = convertToOpenAIFormat([message]);
    const responseInput = convertToOpenAIResponsesFormat([message]);
    for (const payload of [anth, chat, responseInput]) {
      assert.doesNotMatch(JSON.stringify(payload), /resolvedPaths|__foxwarmResolvedToolPaths/);
    }
  } finally {
    await fs.remove(dir);
    await sessionManager.deleteSession(id).catch(() => false);
  }
});

test('remote sidecar is stripped even without a collector and Node identity comes only from dispatch', async () => {
  const session = await sessionManager.getSession('main');
  const original = nodeExecution.executeNodeTool;
  let targetPath = '/node/agent/tmp/a.txt';
  (nodeExecution as any).executeNodeTool = async () => ({ output: 'remote file',
    [RESOLVED_PATH_SIDECAR]: [{ raw: '$fw_tmp/a.txt', resolved: targetPath, nodeId: 'master' }],
  });
  const resolved: ResolvedTool = { invocationName: 'read', source: 'node', name: 'read', args: { filePath: '$fw_tmp/a.txt' },
    executionNode: 'remote-a', permissionNode: 'remote-a' };
  try {
    const paths: Array<{ raw: string; resolved: string }> = [];
    const context = { sessionId: session.id, session, onResolvedPaths: (items: typeof paths) => paths.push(...items) };
    assert.deepEqual(await executeResolvedTool(resolved, context), { output: 'remote file' });
    assert.deepEqual(paths, [{ raw: '$fw_tmp/a.txt', resolved: '/node/agent/tmp/a.txt' }]);
    assert.deepEqual(await executeResolvedTool(resolved, { sessionId: session.id, session }), { output: 'remote file' });
    targetPath = 'C:\\agent\\tmp\\a.txt';
    assert.deepEqual(await executeResolvedTool(resolved, context), { output: 'remote file' });
    assert.deepEqual(paths[1], { raw: '$fw_tmp/a.txt', resolved: targetPath }, 'keep a target-native Windows absolute path even when Code cannot open it');
  } finally { (nodeExecution as any).executeNodeTool = original; }
});
