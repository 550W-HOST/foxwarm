import {
  defineRpcService,
  rpcMethod,
  RpcError,
  RpcServiceHandler,
} from './rpc';
import * as sessionManager from './sessionManager';
import * as interSessionTools from './toolsSessionAgent/interSession';
import * as agentTools from './toolsSessionAgent/agents';
import * as timerTools from './toolsSessionAgent/timers';
import * as timers from './timers';
import type { ToolArgs, ToolContext } from './tools/helpers';

export const MAIN_MANAGEMENT_TOOL_OPERATIONS = [
  'send_to_session',
  'send_to_channel',
  'list_agents',
  'create_timer',
  'list_timers',
  'update_timer',
  'delete_timer',
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
  }
}

export function createMainManagementToolServiceHandler(): RpcServiceHandler<typeof mainManagementToolServiceDescriptor> {
  return {
    async execute(input) {
      const sourceSessionId = normalizeSourceSessionId(input?.sourceSessionId);
      const operation = input?.operation;
      if (typeof operation !== 'string' || !allowedOperations.has(operation)) {
        throw new RpcError('MAIN_MANAGEMENT_OPERATION_NOT_ALLOWED', `Main management operation is not allowed: ${String(operation)}`);
      }
      const args = normalizeArgs(input?.args);
      const source = await sessionManager.getExistingSession(sourceSessionId);
      if (!source) {
        throw new RpcError('MAIN_MANAGEMENT_SOURCE_NOT_FOUND', `Source session \`${sourceSessionId}\` was not found.`);
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
