import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { buildSavedFileText, saveInboundChannelFile, saveInboundSessionFile, saveInboundSessionFileFromPath } from './channelFiles';
import { getAgentDir } from './config';
import * as sessionManager from './sessionManager';
import { nodesManager } from './nodes/manager';
import { read } from './tools';

test('saveInboundSessionFile reports a master absolute Path that remains readable when session cwd is set', async () => {
  const sessionId = `main/channel_file_abs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cwd = path.join(getAgentDir('main'), '.temp', `channel-file-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const session = await sessionManager.getSession(sessionId);
  session.cwd = cwd;
  let savedPath: string | undefined;

  await fs.ensureDir(cwd);

  try {
    const saved = await saveInboundSessionFile({
      sessionId,
      platform: 'webui',
      buffer: Buffer.from('hello from upload'),
      fileName: 'note.txt',
      mimeType: 'text/plain',
    });

    assert.equal(saved.nodeId, 'master');
    assert.equal(path.isAbsolute(saved.promptPath), true);
    assert.equal(saved.promptPath, saved.absolutePath);
    assert.ok(saved.promptPath.startsWith(getAgentDir('main') + path.sep));
    savedPath = saved.promptPath;

    const text = buildSavedFileText(saved, 'file');
    assert.match(text, /Node: master/);
    assert.match(text, new RegExp(`Path: ${saved.promptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(text, /Tool path|Use read/i);

    const readResult = await read({ filePath: saved.promptPath }, { session } as any);
    assert.equal(readResult, 'hello from upload');
    const siblingNames = await fs.readdir(path.dirname(saved.promptPath));
    assert.equal(siblingNames.some(name => name.endsWith('.tmp')), false);
  } finally {
    if (savedPath) await fs.remove(savedPath);
    await fs.remove(cwd);
  }
});

test('saveInboundSessionFileFromPath publishes a master spool atomically without a base64 buffer API', async () => {
  const sessionId = `main/channel_file_spool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempDir = path.join(getAgentDir('main'), '.temp', `channel-file-spool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const sourcePath = path.join(tempDir, 'spool.bin');
  let savedPath: string | undefined;
  await fs.ensureDir(tempDir);

  try {
    await fs.writeFile(sourcePath, Buffer.from('spooled media'));
    const saved = await saveInboundSessionFileFromPath({
      sessionId,
      platform: 'qqbot',
      sourcePath,
      sizeBytes: 13,
      fileName: 'spool.bin',
      mimeType: 'application/octet-stream',
    });
    savedPath = saved.promptPath;
    assert.equal(await fs.readFile(saved.promptPath, 'utf8'), 'spooled media');
    assert.equal((await fs.readdir(path.dirname(saved.promptPath))).some(name => name.endsWith('.tmp')), false);
  } finally {
    if (savedPath) await fs.remove(savedPath);
    await fs.remove(tempDir);
  }
});

test('saveInboundSessionFile stores isolated WebUI uploads on the isolated node and reports its absolute node Path', async () => {
  const originalGetExistingSession = sessionManager.getExistingSession;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalGetAgentIsolationNode = sessionManager.getAgentIsolationNode;
  const originalWriteFileToNode = nodesManager.writeFileToNode.bind(nodesManager);

  let captured: { nodeId?: string; filePath?: string; sessionId?: string } = {};

  try {
    (sessionManager as any).getExistingSession = async () => ({
      id: 'isolated/session',
      agent: 'isolated-agent',
      currentNode: 'sandbox-node',
      cwd: '/workspace/project',
    });
    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    (sessionManager as any).getAgentIsolationNode = () => 'sandbox-node';
    (nodesManager as any).writeFileToNode = async (nodeId: string, filePath: string, _dataBase64: string, _overwrite: boolean, sessionId: string) => {
      captured = { nodeId, filePath, sessionId };
      return { filePath, absolutePath: `/node/agents/isolated-agent/${filePath}`, sizeBytes: 5, sha256: 'hash', overwritten: false };
    };

    const saved = await saveInboundSessionFile({
      sessionId: 'isolated/session',
      platform: 'webui',
      buffer: Buffer.from('hello'),
      fileName: 'note.txt',
      mimeType: 'text/plain',
    });

    assert.equal(captured.nodeId, 'sandbox-node');
    assert.equal(captured.sessionId, 'isolated/session');
    assert.match(String(captured.filePath), /^\.temp[\\/]channel-files[\\/]webui[\\/]/);
    assert.equal(saved.nodeId, 'sandbox-node');
    assert.equal(saved.promptPath, `/node/agents/isolated-agent/${captured.filePath}`);
    assert.equal(path.isAbsolute(saved.promptPath), true);
    assert.match(buildSavedFileText(saved, 'file'), /Node: sandbox-node/);
    assert.match(buildSavedFileText(saved, 'file'), /Path: \/node\/agents\/isolated-agent\/\.temp[\\/]channel-files[\\/]webui[\\/]/);
    assert.doesNotMatch(buildSavedFileText(saved, 'file'), /Tool path|Use read/i);
  } finally {
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
    (nodesManager as any).writeFileToNode = originalWriteFileToNode;
  }
});

test('path-based inbound media rejects isolated-node whole-buffer transfer instead of claiming streaming support', async () => {
  const originalGetExistingSession = sessionManager.getExistingSession;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalGetAgentIsolationNode = sessionManager.getAgentIsolationNode;
  const sourcePath = path.join(getAgentDir('main'), '.temp', `qq-media-spool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);

  try {
    await fs.ensureDir(path.dirname(sourcePath));
    await fs.writeFile(sourcePath, Buffer.from('bounded'));
    (sessionManager as any).getExistingSession = async () => ({ id: 'isolated/session', agent: 'isolated-agent', currentNode: 'sandbox-node' });
    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    (sessionManager as any).getAgentIsolationNode = () => 'sandbox-node';

    await assert.rejects(
      saveInboundSessionFileFromPath({
        sessionId: 'isolated/session',
        platform: 'qqbot',
        sourcePath,
        sizeBytes: 7,
        fileName: 'bounded.bin',
        mimeType: 'application/octet-stream',
      }),
      /whole-buffer only and has no bounded streaming boundary/,
    );
  } finally {
    await fs.remove(sourcePath);
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
  }
});

test('saveInboundChannelFile stores isolated channel uploads on the isolated node via the shared helper', async () => {
  const originalGetSessionByChannel = sessionManager.getSessionByChannel;
  const originalGetExistingSession = sessionManager.getExistingSession;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalGetAgentIsolationNode = sessionManager.getAgentIsolationNode;
  const originalWriteFileToNode = nodesManager.writeFileToNode.bind(nodesManager);

  let captured: { nodeId?: string; filePath?: string; sessionId?: string } = {};

  try {
    (sessionManager as any).getSessionByChannel = () => 'isolated/session';
    (sessionManager as any).getExistingSession = async () => ({
      id: 'isolated/session',
      agent: 'isolated-agent',
      currentNode: 'master',
    });
    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    (sessionManager as any).getAgentIsolationNode = () => 'sandbox-node';
    (nodesManager as any).writeFileToNode = async (nodeId: string, filePath: string, _dataBase64: string, _overwrite: boolean, sessionId: string) => {
      captured = { nodeId, filePath, sessionId };
      return { filePath, absolutePath: `/node/agents/isolated-agent/${filePath}`, sizeBytes: 3, sha256: 'hash', overwritten: false };
    };

    const saved = await saveInboundChannelFile({
      platform: 'telegram',
      channelUserId: 'chat-1',
      buffer: Buffer.from('abc'),
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      isImage: true,
    });

    assert.equal(captured.nodeId, 'sandbox-node');
    assert.equal(captured.sessionId, 'isolated/session');
    assert.match(String(captured.filePath), /^\.temp[\\/]channel-files[\\/]telegram[\\/]/);
    assert.equal(saved.nodeId, 'sandbox-node');
    assert.equal(saved.promptPath, `/node/agents/isolated-agent/${captured.filePath}`);
    assert.equal(path.isAbsolute(saved.promptPath), true);
    assert.match(buildSavedFileText(saved, 'image'), /Node: sandbox-node/);
    assert.match(buildSavedFileText(saved, 'image'), /Path: \/node\/agents\/isolated-agent\/\.temp[\\/]channel-files[\\/]telegram[\\/]/);
  } finally {
    (sessionManager as any).getSessionByChannel = originalGetSessionByChannel;
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
    (nodesManager as any).writeFileToNode = originalWriteFileToNode;
  }
});