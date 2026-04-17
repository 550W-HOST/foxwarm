import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSavedFileText, saveInboundChannelFile, saveInboundSessionFile } from './channelFiles';
import * as sessionManager from './sessionManager';
import { nodesManager } from './nodes/manager';

test('saveInboundSessionFile stores isolated WebUI uploads on the isolated node under agent-dir-relative temp path and ignores cwd', async () => {
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
      return { filePath, sizeBytes: 5, sha256: 'hash', overwritten: false };
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
    assert.equal(saved.promptPath, captured.filePath);
    assert.match(buildSavedFileText(saved, 'file'), /Node: sandbox-node/);
    assert.match(buildSavedFileText(saved, 'file'), /Path: \.temp[\\/]channel-files[\\/]webui[\\/]/);
  } finally {
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
    (nodesManager as any).writeFileToNode = originalWriteFileToNode;
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
      return { filePath, sizeBytes: 3, sha256: 'hash', overwritten: false };
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
    assert.equal(saved.promptPath, captured.filePath);
    assert.match(buildSavedFileText(saved, 'image'), /Node: sandbox-node/);
  } finally {
    (sessionManager as any).getSessionByChannel = originalGetSessionByChannel;
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
    (nodesManager as any).writeFileToNode = originalWriteFileToNode;
  }
});