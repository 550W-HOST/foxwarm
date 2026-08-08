import {
  defineRpcService,
  rpcMethod,
  RpcError,
  RpcServiceHandler,
} from './rpc';
import * as sessionManager from './sessionManager';
import * as interSessionTools from './toolsSessionAgent/interSession';
import * as archiveRecallTools from './toolsSessionAgent/archiveRecall';
import * as agentTools from './toolsSessionAgent/agents';
import * as timerTools from './toolsSessionAgent/timers';
import * as timers from './timers';
import type { ToolArgs, ToolContext } from './tools/helpers';
import { readDetachedWorkerSession } from './sessionWorkerSnapshot';
import { buildSessionListOutput } from './sessionStatus';
import type { SessionWorkerStore } from './sessionWorkerStore';

export const MAIN_MANAGEMENT_TOOL_OPERATIONS = [
  'send_to_session',
  'send_to_channel',
  'list_agents',
  'create_timer',
  'list_timers',
  'update_timer',
  'delete_timer',
  'create_child_session',
  'session_list',
  'get_session_messages',
] as const;

export type MainManagementToolOperation = typeof MAIN_MANAGEMENT_TOOL_OPERATIONS[number];
export type MainManagementToolRequest = {
  sourceSessionId: string;
  operation: MainManagementToolOperation;
  args: ToolArgs;
};
export type MainManagementToolResponse = { result: unknown };
export type ScheduleWaitTimeoutRequest = { sourceSessionId: string; waitId: string; timeoutSeconds: number };
export type ScheduleWaitTimeoutResponse = { scheduled: true; waitId: string };

export const mainManagementToolServiceDescriptor = defineRpcService('main-management-tools', 1, {
  execute: rpcMethod<MainManagementToolRequest, MainManagementToolResponse>(),
  scheduleWaitTimeout: rpcMethod<ScheduleWaitTimeoutRequest, ScheduleWaitTimeoutResponse>(),
});

const allowedOperations = new Set<string>(MAIN_MANAGEMENT_TOOL_OPERATIONS);

function normalizeSourceSessionId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError('MAIN_MANAGEMENT_SOURCE_REQUIRED', 'sourceSessionId must be a non-empty string.');
  }
  return value.trim();
}

function normalizeArgs(value: unknown): ToolArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'args must be an object.');
  }
  return value as ToolArgs;
}

function normalizeNonEmptyString(value: unknown, field: 'waitId'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError('MAIN_MANAGEMENT_INVALID_WAIT_TIMEOUT', `${field} must be a non-empty string.`);
  }
  return value.trim();
}

async function invokeAllowedOperation(operation: MainManagementToolOperation, args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  // Read module exports at call time so established test/runtime replacement
  // seams are not frozen when the service is initialized.
  switch (operation) {
    case 'send_to_session': return interSessionTools.tool_send_to_session(args, ctx);
    case 'send_to_channel': return interSessionTools.tool_send_to_channel(args, ctx);
    case 'list_agents': return agentTools.tool_list_agents(args, ctx);
    case 'create_timer': return timerTools.tool_create_timer(args, ctx);
    case 'list_timers': return timerTools.tool_list_timers(args, ctx);
    case 'update_timer': return timerTools.tool_update_timer(args, ctx);
    case 'delete_timer': return timerTools.tool_delete_timer(args, ctx);
    case 'session_list': return buildSessionListOutput(args, ctx.sessionId);
  }
}

const CREATE_CHILD_SESSION_KEYS = new Set(['suffix', 'fork', 'message', 'noFurtherAssistantReply', 'waitAfterHandoff']);

function normalizeCreateChildSessionArgs(args: ToolArgs): ToolArgs {
  const keys = Object.keys(args);
  if (keys.some(key => !CREATE_CHILD_SESSION_KEYS.has(key))) {
    throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'create_child_session accepts only suffix, fork, message, noFurtherAssistantReply, and waitAfterHandoff.');
  }
  if (typeof args.suffix !== 'string' || !args.suffix.trim()) {
    throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'create_child_session requires a non-empty suffix.');
  }
  for (const key of ['fork', 'noFurtherAssistantReply', 'waitAfterHandoff'] as const) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') {
      throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', `create_child_session ${key} must be a boolean when provided.`);
    }
  }
  if (args.message !== undefined && typeof args.message !== 'string') {
    throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'create_child_session message must be a string when provided.');
  }
  return args;
}

export function createMainManagementToolServiceHandler(options: {
  expectedSourceSessionId?: string;
  expectedGeneration?: number;
  expectedIncarnationId?: string;
  workerStore?: SessionWorkerStore;
} = {}): RpcServiceHandler<typeof mainManagementToolServiceDescriptor> {
  const assertExpectedSource = (sourceSessionId: string): void => {
    if (options.expectedSourceSessionId && sourceSessionId !== options.expectedSourceSessionId) {
      throw new RpcError('MAIN_MANAGEMENT_SOURCE_MISMATCH', `Main management reverse source must be \`${options.expectedSourceSessionId}\`.`);
    }
    // A reverse caller bound to one worker generation must still be that exact
    // durable owner; a stale generation fails closed retryably.
    if (options.expectedGeneration !== undefined || options.expectedIncarnationId !== undefined) {
      const ownership = options.workerStore?.findOwnership(sourceSessionId);
      if (!ownership || ownership.generation !== options.expectedGeneration || ownership.incarnationId !== options.expectedIncarnationId) {
        throw new RpcError('MAIN_MANAGEMENT_SOURCE_STALE', `Main management reverse source \`${sourceSessionId}\` is not the exact current worker generation.`, true);
      }
    }
  };
  const invokeCreateChildSession = async (args: ToolArgs, sourceSessionId: string, source: any): Promise<unknown> => {
    const bounded = normalizeCreateChildSessionArgs(args);
    const ownership = options.workerStore?.findOwnership(sourceSessionId);
    if (bounded.fork === true && options.workerStore && !ownership) {
      throw new RpcError('MAIN_MANAGEMENT_FORK_UNFENCED', `Cannot fork session \`${sourceSessionId}\`: it has no durable worker fence to derive from.`, true);
    }
    // A fork of a worker-fenced source must derive from the authoritative JSON
    // via a strictly read-only detached read; Main never hydrates or writes it.
    const sourceOverride = bounded.fork === true && ownership
      ? await readDetachedWorkerSession(sourceSessionId, source)
      : source;
    return interSessionTools.tool_create_child_session(bounded, { sessionId: sourceSessionId, sourceOverride } as ToolContext);
  };
  const invokeGetSessionMessages = async (args: ToolArgs, sourceSessionId: string): Promise<unknown> => {
    const targetId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
    if (!targetId) throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'get_session_messages requires a sessionId.');
    const target = await sessionManager.getExistingSession(targetId);
    if (!target) return `Session \`${targetId}\` not found.`;
    // A worker-fenced target is served from its authoritative JSON via a
    // strictly read-only detached read; Main never hydrates it.
    if (options.workerStore?.findOwnership(target.id)) {
      const detached = await readDetachedWorkerSession(target.id, target);
      return archiveRecallTools.tool_get_session_messages(args, { sessionId: detached.id, session: detached, persistCurrentSession: async () => {} } as unknown as ToolContext);
    }
    return archiveRecallTools.tool_get_session_messages(args, { sessionId: sourceSessionId });
  };
  return {
    async execute(input) {
      const sourceSessionId = normalizeSourceSessionId(input?.sourceSessionId);
      assertExpectedSource(sourceSessionId);
      const operation = input?.operation;
      if (typeof operation !== 'string' || !allowedOperations.has(operation)) {
        throw new RpcError('MAIN_MANAGEMENT_OPERATION_NOT_ALLOWED', `Main management operation is not allowed: ${String(operation)}`);
      }
      const args = normalizeArgs(input?.args);
      const source = await sessionManager.getExistingSession(sourceSessionId);
      if (!source) {
        throw new RpcError('MAIN_MANAGEMENT_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
      }

      if (operation === 'create_child_session') {
        return { result: await invokeCreateChildSession(args, sourceSessionId, source) };
      }
      if (operation === 'get_session_messages') {
        return { result: await invokeGetSessionMessages(args, sourceSessionId) };
      }
      return {
        result: await invokeAllowedOperation(operation as MainManagementToolOperation, args, { sessionId: sourceSessionId }),
      };
    },
    async scheduleWaitTimeout(input) {
      const prototype = input && typeof input === 'object' ? Object.getPrototypeOf(input) : undefined;
      const keys = input && typeof input === 'object' ? Object.keys(input) : [];
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || (prototype !== Object.prototype && prototype !== null)
        || keys.length !== 3
        || keys.some(key => !['sourceSessionId', 'waitId', 'timeoutSeconds'].includes(key))) {
        throw new RpcError('MAIN_MANAGEMENT_INVALID_WAIT_TIMEOUT', 'scheduleWaitTimeout requires exactly sourceSessionId, waitId, and timeoutSeconds.');
      }
      const sourceSessionId = normalizeSourceSessionId(input.sourceSessionId);
      assertExpectedSource(sourceSessionId);
      const waitId = normalizeNonEmptyString(input.waitId, 'waitId');
      if (typeof input.timeoutSeconds !== 'number' || !Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
        throw new RpcError('MAIN_MANAGEMENT_INVALID_WAIT_TIMEOUT', 'timeoutSeconds must be a positive finite number.');
      }
      const source = await sessionManager.getExistingSession(sourceSessionId);
      if (!source) {
        throw new RpcError('MAIN_MANAGEMENT_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
      }
      await timers.createWaitTimeoutTimer({ sessionId: sourceSessionId, waitId, timeoutSeconds: input.timeoutSeconds });
      return { scheduled: true, waitId };
    },
  };
}
