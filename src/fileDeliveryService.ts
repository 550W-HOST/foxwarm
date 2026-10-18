import { parseFileDeliveryArtifact, type FileDeliveryArtifact } from '../packages/shared/dist/fileDelivery';
import { defineRpcService, rpcMethod, RpcError, type RpcServiceHandler } from './rpc';
import * as sessionManager from './sessionManager';
import { executeSendFileMain } from './toolsSessionAgent/interSession';
import { requireNodeExecutionAccess } from './nodeExecutionService';
import { checkToolPermissionForSession } from './isolatedCheck';
import { readOwnedImageWriteHandoff } from './imageWriteHandoff';
import { checkGenericToolAuthorizationForSession } from './isolatedCheck';

export type FileDeliveryRouting = { runtimeNodeId: string; currentNode: string; cwd?: string };

export type FileDeliveryRequest = {
  sourceSessionId: string;
  intent: { sessionId?: string; channelTargetId?: string; filePath: string; caption?: string; text?: string };
  routing: FileDeliveryRouting;
};
export type FileDeliveryResponse = { output: string; fullPath: string; fileDelivery?: FileDeliveryArtifact };

export type ImageArtifactWriteRequest = {
  sourceSessionId: string;
  artifactPath: string;
  intent: { id: string; filePath: string; overwrite?: boolean };
  routing: FileDeliveryRouting;
};

export const fileDeliveryServiceDescriptor = defineRpcService('file-delivery', 2, {
  deliver: rpcMethod<FileDeliveryRequest, FileDeliveryResponse>(),
  writeImageArtifact: rpcMethod<ImageArtifactWriteRequest, { written: true }>(),
});

function onlyKeys(value: object, keys: readonly string[], label: string) {
  const key = Object.keys(value).find(item => !keys.includes(item));
  if (key) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', `${label} contains unsupported field: ${key}.`);
}
function bounded(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', `${field} must be a non-empty string.`);
  const result = value.trim();
  if (result.length > max) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', `${field} exceeds ${max} characters.`);
  return result;
}
function boundedRaw(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value === '') throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', `${field} must be a non-empty string.`);
  if (value.length > max) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', `${field} exceeds ${max} characters.`);
  return value;
}
function boundedUtf8(value: unknown, maxBytes: number): string {
  const text = String(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function requireSource(input: any, allowedKeys: string[], expectedSourceSessionId?: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'File delivery request must be an object.');
  onlyKeys(input, allowedKeys, 'request');
  const sourceSessionId = bounded(input.sourceSessionId, 'sourceSessionId', 256)!;
  if (expectedSourceSessionId && sourceSessionId !== expectedSourceSessionId) {
    throw new RpcError('FILE_DELIVERY_SOURCE_MISMATCH', `File delivery reverse source must be \`${expectedSourceSessionId}\`.`);
  }
  const source = sessionManager.getSessionCatalog(sourceSessionId);
  if (!source) throw new RpcError('FILE_DELIVERY_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
  return { sourceSessionId, source };
}

function normalizeRouting(value: FileDeliveryRouting): FileDeliveryRouting {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'routing must be an object.');
  onlyKeys(value, ['runtimeNodeId', 'currentNode', 'cwd'], 'routing');
  const runtimeNodeId = bounded(value.runtimeNodeId, 'routing.runtimeNodeId', 128)!;
  const currentNode = bounded(value.currentNode, 'routing.currentNode', 128)!;
  const cwd = value.cwd === undefined ? undefined : boundedRaw(value.cwd, 'routing.cwd', 4096);
  return { runtimeNodeId, currentNode, ...(cwd !== undefined ? { cwd } : {}) };
}

export function createFileDeliveryServiceHandler(options: { expectedSourceSessionId?: string } = {}): RpcServiceHandler<typeof fileDeliveryServiceDescriptor> {
  return {
    async deliver(input) {
      const { sourceSessionId, source } = requireSource(input, ['sourceSessionId', 'intent', 'routing'], options.expectedSourceSessionId);
      if (!input.intent || typeof input.intent !== 'object' || Array.isArray(input.intent)) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'intent must be an object.');
      onlyKeys(input.intent, ['sessionId', 'channelTargetId', 'filePath', 'caption', 'text'], 'intent');
      const { runtimeNodeId, currentNode, cwd } = normalizeRouting(input.routing);
      const intent = {
        ...(input.intent.sessionId !== undefined ? { sessionId: bounded(input.intent.sessionId, 'intent.sessionId', 256) } : {}),
        ...(input.intent.channelTargetId !== undefined ? { channelTargetId: bounded(input.intent.channelTargetId, 'intent.channelTargetId', 512) } : {}),
        filePath: bounded(input.intent.filePath, 'intent.filePath', 4096)!,
        ...(input.intent.caption !== undefined ? { caption: bounded(input.intent.caption, 'intent.caption', 4096) } : {}),
        ...(input.intent.text !== undefined ? { text: bounded(input.intent.text, 'intent.text', 4096) } : {}),
      };
      if (runtimeNodeId !== 'master') await requireNodeExecutionAccess(sourceSessionId, runtimeNodeId);
      const exactSource = { ...source, currentNode, ...(cwd !== undefined ? { cwd } : { cwd: undefined }) };
      await checkGenericToolAuthorizationForSession(exactSource, { source: 'builtin', tool: 'send_file' }, runtimeNodeId, intent);
      let result: any;
      try { result = await executeSendFileMain(intent, { sessionId: sourceSessionId, session: exactSource, runtimeNodeId } as any); }
      catch (error: any) {
        throw new RpcError('FILE_DELIVERY_FAILED', boundedUtf8(error?.message || error, 16 * 1024));
      }
      if (!result || typeof result !== 'object' || typeof result.output !== 'string' || typeof result.fullPath !== 'string') {
        throw new RpcError('FILE_DELIVERY_INVALID_RESPONSE', 'File delivery returned an invalid result.');
      }
      if (result.fullPath.length > 4096) throw new RpcError('FILE_DELIVERY_INVALID_RESPONSE', 'File delivery fullPath exceeds 4096 characters.');
      const fileDelivery = parseFileDeliveryArtifact(result.fileDelivery);
      if (result.fileDelivery !== undefined && (!fileDelivery || fileDelivery.downloadPath !== result.fullPath)) throw new RpcError('FILE_DELIVERY_INVALID_RESPONSE', 'File delivery receipt is invalid.');
      return { output: boundedUtf8(result.output, 16 * 1024), fullPath: result.fullPath, ...(fileDelivery ? { fileDelivery } : {}) };
    },
    async writeImageArtifact(input) {
      const { sourceSessionId, source } = requireSource(input,
        ['sourceSessionId', 'artifactPath', 'intent', 'routing'], options.expectedSourceSessionId);
      if (!input.intent || typeof input.intent !== 'object' || Array.isArray(input.intent)) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'intent must be an object.');
      onlyKeys(input.intent, ['id', 'filePath', 'overwrite'], 'intent');
      const intent = {
        id: boundedRaw(input.intent.id, 'intent.id', 4096),
        filePath: boundedRaw(input.intent.filePath, 'intent.filePath', 4096),
        ...(input.intent.overwrite !== undefined ? { overwrite: input.intent.overwrite } : {}),
      };
      if (input.intent.overwrite !== undefined && typeof input.intent.overwrite !== 'boolean') throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'overwrite must be boolean.');
      const artifactPath = boundedRaw(input.artifactPath, 'artifactPath', 4096);
      const { runtimeNodeId, currentNode } = normalizeRouting(input.routing);
      if (runtimeNodeId === 'master') throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'Image handoff requires a non-master target.');
      await requireNodeExecutionAccess(sourceSessionId, runtimeNodeId);
      await checkToolPermissionForSession({ ...source, currentNode },
        { source: 'builtin', tool: 'image_write_to_file' }, runtimeNodeId, intent);
      try {
        const bytes = await readOwnedImageWriteHandoff(source.agent || 'main', sourceSessionId, artifactPath);
        const { nodeProviderRegistry } = await import('./nodes/providers');
        await nodeProviderRegistry.writeTransferFile({ sourceSessionId, nodeId: runtimeNodeId,
          filePath: intent.filePath, dataBase64: bytes.toString('base64'), overwrite: intent.overwrite === true, context: { agent: source.agent || 'main' } });
      } catch (error: any) {
        throw new RpcError('FILE_DELIVERY_FAILED', boundedUtf8(error?.message || error, 16 * 1024));
      }
      return { written: true };
    },
  };
}
