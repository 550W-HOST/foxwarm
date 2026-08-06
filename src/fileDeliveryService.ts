import { defineRpcService, rpcMethod, RpcError, type RpcServiceHandler } from './rpc';
import * as sessionManager from './sessionManager';
import { executeSendFileMain } from './toolsSessionAgent/interSession';
import { requireNodeExecutionTarget } from './nodeExecutionService';

export type FileDeliveryRequest = {
  sourceSessionId: string;
  intent: { sessionId?: string; channelTargetId?: string; filePath: string; caption?: string; text?: string };
  routing: { runtimeNodeId: string; currentNode: string; cwd?: string };
};
export type FileDeliveryResponse = { output: string; fullPath: string };

export const fileDeliveryServiceDescriptor = defineRpcService('file-delivery', 1, {
  deliver: rpcMethod<FileDeliveryRequest, FileDeliveryResponse>(),
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

export function createFileDeliveryServiceHandler(options: { expectedSourceSessionId?: string } = {}): RpcServiceHandler<typeof fileDeliveryServiceDescriptor> {
  return {
    async deliver(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'File delivery request must be an object.');
      onlyKeys(input, ['sourceSessionId', 'intent', 'routing'], 'request');
      const sourceSessionId = bounded(input.sourceSessionId, 'sourceSessionId', 256)!;
      if (options.expectedSourceSessionId && sourceSessionId !== options.expectedSourceSessionId) {
        throw new RpcError('FILE_DELIVERY_SOURCE_MISMATCH', `File delivery reverse source must be \`${options.expectedSourceSessionId}\`.`);
      }
      const source = await sessionManager.getExistingSession(sourceSessionId);
      if (!source) throw new RpcError('FILE_DELIVERY_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
      if (!input.intent || typeof input.intent !== 'object' || Array.isArray(input.intent)) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'intent must be an object.');
      if (!input.routing || typeof input.routing !== 'object' || Array.isArray(input.routing)) throw new RpcError('FILE_DELIVERY_INVALID_REQUEST', 'routing must be an object.');
      onlyKeys(input.intent, ['sessionId', 'channelTargetId', 'filePath', 'caption', 'text'], 'intent');
      onlyKeys(input.routing, ['runtimeNodeId', 'currentNode', 'cwd'], 'routing');
      const runtimeNodeId = bounded(input.routing.runtimeNodeId, 'routing.runtimeNodeId', 128)!;
      const currentNode = bounded(input.routing.currentNode, 'routing.currentNode', 128)!;
      const cwd = input.routing.cwd === undefined ? undefined : boundedRaw(input.routing.cwd, 'routing.cwd', 4096);
      const intent = {
        ...(input.intent.sessionId !== undefined ? { sessionId: bounded(input.intent.sessionId, 'intent.sessionId', 256) } : {}),
        ...(input.intent.channelTargetId !== undefined ? { channelTargetId: bounded(input.intent.channelTargetId, 'intent.channelTargetId', 512) } : {}),
        filePath: bounded(input.intent.filePath, 'intent.filePath', 4096)!,
        ...(input.intent.caption !== undefined ? { caption: bounded(input.intent.caption, 'intent.caption', 4096) } : {}),
        ...(input.intent.text !== undefined ? { text: bounded(input.intent.text, 'intent.text', 4096) } : {}),
      };
      if (runtimeNodeId !== 'master') await requireNodeExecutionTarget(sourceSessionId, runtimeNodeId);
      const exactSource = { ...source, currentNode, ...(cwd !== undefined ? { cwd } : { cwd: undefined }) };
      let result: any;
      try { result = await executeSendFileMain(intent, { sessionId: sourceSessionId, session: exactSource, runtimeNodeId } as any); }
      catch (error: any) {
        throw new RpcError('FILE_DELIVERY_FAILED', boundedUtf8(error?.message || error, 16 * 1024));
      }
      if (!result || typeof result !== 'object' || typeof result.output !== 'string' || typeof result.fullPath !== 'string') {
        throw new RpcError('FILE_DELIVERY_INVALID_RESPONSE', 'File delivery returned an invalid result.');
      }
      if (result.fullPath.length > 4096) throw new RpcError('FILE_DELIVERY_INVALID_RESPONSE', 'File delivery fullPath exceeds 4096 characters.');
      return { output: boundedUtf8(result.output, 16 * 1024), fullPath: result.fullPath };
    },
  };
}
