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
import * as sessionCrudTools from './toolsSessionAgent/sessionCrud';
import * as nodeTools from './tools/nodeTools';
import * as timers from './timers';
import type { ToolArgs, ToolContext } from './tools/helpers';
import { normalizeCreateChildSessionArgs, normalizeCreateSessionArgs } from './toolsSessionAgent/helpers';
import { readDetachedWorkerSession } from './sessionWorkerSnapshot';
import { buildSessionListOutput } from './sessionStatus';
import type { SessionWorkerStore } from './sessionWorkerStore';
import type { Session } from './types';
import type { SessionRuntimeHistoryDto } from './sessionRuntimeService';
import { armWaitLivenessDiagnostic, initializeWaitLivenessDiagnostics } from './waitLiveness';

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
  'session_update_display_name',
  'get_session_messages',
  'get_archived_messages',
  'get_archived_blocks',
  'recall',
  'create_agent',
  'create_session',
  'delete_session',
  'node_bootstrap_info',
  'node_pair_list',
  'node_pair_approve',
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
export type ValidateWaitSessionsRequest = { sourceSessionId: string; sessionIds: string[] };
export type ValidateWaitSessionsResponse = { sessionIds: string[] };
export type ArmWaitLivenessRequest = { sourceSessionId: string; waitId: string };
export type ArmWaitLivenessResponse = { armed: true };

export const mainManagementToolServiceDescriptor = defineRpcService('main-management-tools', 7, {
  execute: rpcMethod<MainManagementToolRequest, MainManagementToolResponse>(),
  scheduleWaitTimeout: rpcMethod<ScheduleWaitTimeoutRequest, ScheduleWaitTimeoutResponse>(),
  validateWaitSessions: rpcMethod<ValidateWaitSessionsRequest, ValidateWaitSessionsResponse>(),
  armWaitLiveness: rpcMethod<ArmWaitLivenessRequest, ArmWaitLivenessResponse>(),
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
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'args must be JSON-serializable.'); }
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) {
    throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'args exceed the 64 KiB Main-management bound.');
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
    case 'session_update_display_name': return sessionCrudTools.tool_session(args, ctx);
    case 'get_archived_messages': return archiveRecallTools.tool_get_archived_messages(args, ctx);
    case 'get_archived_blocks': return archiveRecallTools.tool_get_archived_blocks(args, ctx);
    case 'recall': return archiveRecallTools.tool_recall(args, ctx);
    case 'create_agent': return agentTools.tool_create_agent(args, ctx);
    case 'create_session': return agentTools.tool_create_session(args, ctx);
    case 'node_bootstrap_info': return nodeTools.tool_node_bootstrap_info(args, ctx);
    case 'node_pair_list': return nodeTools.tool_node_pair_list(args, ctx);
    case 'node_pair_approve': return nodeTools.tool_node_pair_approve(args, ctx);
  }
}

const mainManagementArgError = (message: string): RpcError => new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', message);

function normalizeDeleteSessionArgs(args: ToolArgs): ToolArgs {
  if (Object.keys(args).length !== 1 || typeof args.sessionId !== 'string' || !args.sessionId.trim()
    || Buffer.byteLength(args.sessionId, 'utf8') > 256) {
    throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'delete_session requires exactly one bounded non-empty sessionId.');
  }
  return { sessionId: args.sessionId };
}

export function createMainManagementToolServiceHandler(options: {
  expectedSourceSessionId?: string;
  expectedGeneration?: number;
  expectedIncarnationId?: string;
  workerStore?: SessionWorkerStore;
  readSessionHistory?: (sessionId: string) => Promise<SessionRuntimeHistoryDto | null>;
} = {}): RpcServiceHandler<typeof mainManagementToolServiceDescriptor> {
  initializeWaitLivenessDiagnostics();
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
    const bounded = normalizeCreateChildSessionArgs(args, mainManagementArgError);
    const ownership = options.workerStore?.findOwnership(sourceSessionId);
    if (bounded.fork === true && options.workerStore && !ownership) {
      throw new RpcError('MAIN_MANAGEMENT_FORK_UNFENCED', `Cannot fork session \`${sourceSessionId}\`: it has no durable worker fence to derive from.`, true);
    }
    // Child creation inherits current source settings even without fork. A
    // worker-owned source therefore always derives from the authoritative JSON
    // through a read-only detached snapshot; Main never hydrates or writes it.
    const sourceOverride = ownership
      ? await readDetachedWorkerSession(sourceSessionId, source)
      : source;
    return interSessionTools.tool_create_child_session(bounded, { sessionId: sourceSessionId, sourceOverride } as ToolContext);
  };
  const invokeGetSessionMessages = async (args: ToolArgs, sourceSessionId: string): Promise<unknown> => {
    const targetId = typeof args?.sessionId === 'string' ? args.sessionId : undefined;
    if (!targetId) throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'get_session_messages requires a sessionId.');
    // Catalog-map-only: hydrating a worker-fenced stub would poison later local reads.
    const target = sessionManager.getSessionCatalog(targetId);
    if (!target) return `Session \`${targetId}\` not found.`;
    // Production injects SessionRuntime so this read ensures/loads the exact
    // target owner. Isolated service tests may use the same read-only file
    // reader directly; neither path hydrates a Main catalog stub.
    if (options.workerStore) {
      const detached = options.readSessionHistory
        ? await options.readSessionHistory(target.id).then(snapshot => snapshot ? ({
          ...target,
          ...snapshot.session,
          history: snapshot.messages,
          queue: snapshot.queue,
          persistentMemorySnapshot: snapshot.persistentMemorySnapshot,
        } as Session) : null)
        : await readDetachedWorkerSession(target.id, target);
      if (!detached) return `Session \`${targetId}\` not found.`;
      return archiveRecallTools.tool_get_session_messages(args, { sessionId: detached.id, session: detached, persistCurrentSession: async () => {} } as unknown as ToolContext);
    }
    return archiveRecallTools.tool_get_session_messages(args, { sessionId: sourceSessionId });
  };
  const exactSourceContext = async (sourceSessionId: string, source: Session): Promise<ToolContext> => {
    const ownership = options.workerStore?.findOwnership(sourceSessionId);
    const exactSource = ownership ? await readDetachedWorkerSession(sourceSessionId, source) : source;
    return { sessionId: sourceSessionId, session: exactSource, detachedReadOnlySession: true } as ToolContext;
  };
  return {
    async execute(input) {
      const sourceSessionId = normalizeSourceSessionId(input?.sourceSessionId);
      assertExpectedSource(sourceSessionId);
      const operation = input?.operation;
      if (typeof operation !== 'string' || !allowedOperations.has(operation)) {
        throw new RpcError('MAIN_MANAGEMENT_OPERATION_NOT_ALLOWED', `Main management operation is not allowed: ${String(operation)}`);
      }
      let args = normalizeArgs(input?.args);
      const source = sessionManager.getAllSessions().get(sourceSessionId);
      if (!source) {
        throw new RpcError('MAIN_MANAGEMENT_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
      }

      if (operation === 'create_child_session') {
        return { result: await invokeCreateChildSession(args, sourceSessionId, source) };
      }
      if (operation === 'create_session') {
        args = normalizeCreateSessionArgs(args, mainManagementArgError);
      }
      if (operation === 'get_session_messages') {
        return { result: await invokeGetSessionMessages(args, sourceSessionId) };
      }
      if (operation === 'delete_session') {
        // The reverse source fence is checked at ingress and again by the
        // operation-specific orchestrator immediately before target teardown
        // and final graph mutation. No live source Session crosses the RPC.
        return { result: await sessionCrudTools.deleteSessionForSource(
          normalizeDeleteSessionArgs(args),
          sourceSessionId,
          () => assertExpectedSource(sourceSessionId),
        ) };
      }
      if (operation === 'create_agent' && args.convertSession === true) {
        throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'create_agent convertSession is unavailable from a Session worker because it mutates the source identity.');
      }
      if (operation === 'create_agent' && typeof args.sourceSessionId === 'string'
        && args.sourceSessionId !== sourceSessionId && !source.aliases?.includes(args.sourceSessionId)) {
        throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'create_agent from another source session is unavailable from a Session worker.');
      }
      if (operation === 'session_update_display_name') {
        const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
        const requestedTarget = typeof args.sessionId === 'string' && args.sessionId.trim() ? args.sessionId.trim() : sourceSessionId;
        const target = sessionManager.getSessionCatalog(requestedTarget);
        if (action !== 'update-display-name' || typeof args.name !== 'string'
          || !target || target.id !== sourceSessionId) {
          throw new RpcError('MAIN_MANAGEMENT_INVALID_ARGS', 'session_update_display_name requires the exact source session, update-display-name action, and a string name.');
        }
      }
      const needsExactSource = ['get_archived_messages', 'get_archived_blocks', 'recall', 'create_agent', 'create_session'].includes(operation);
      return { result: await invokeAllowedOperation(
        operation as MainManagementToolOperation,
        args,
        needsExactSource
          ? await exactSourceContext(sourceSessionId, source)
          : {
            sessionId: sourceSessionId,
            ...(operation === 'send_to_session' ? { captureSuccessfulSendToSessionTarget: true } : {}),
          },
      ) };
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
      const source = sessionManager.getAllSessions().get(sourceSessionId);
      if (!source) {
        throw new RpcError('MAIN_MANAGEMENT_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
      }
      await timers.createWaitTimeoutTimer({ sessionId: sourceSessionId, waitId, timeoutSeconds: input.timeoutSeconds });
      return { scheduled: true, waitId };
    },
    async validateWaitSessions(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 2
        || typeof input.sourceSessionId !== 'string'
        || !Array.isArray(input.sessionIds)
        || input.sessionIds.length < 1 || input.sessionIds.length > 64
        || input.sessionIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 512)) {
        throw new RpcError('MAIN_MANAGEMENT_INVALID_WAIT_SESSIONS', 'validateWaitSessions requires sourceSessionId and 1-64 non-empty sessionIds.');
      }
      const sourceSessionId = normalizeSourceSessionId(input.sourceSessionId);
      assertExpectedSource(sourceSessionId);
      return { sessionIds: await sessionManager.validateSessionWaitTargets(sourceSessionId, input.sessionIds) };
    },
    async armWaitLiveness(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 2
        || typeof input.sourceSessionId !== 'string' || typeof input.waitId !== 'string' || !input.waitId.trim()) {
        throw new RpcError('MAIN_MANAGEMENT_INVALID_WAIT_LIVENESS', 'armWaitLiveness requires sourceSessionId and waitId.');
      }
      const sourceSessionId = normalizeSourceSessionId(input.sourceSessionId);
      assertExpectedSource(sourceSessionId);
      armWaitLivenessDiagnostic(sourceSessionId, input.waitId);
      return { armed: true };
    },
  };
}
