import type { FunctionResponse } from './types';
import * as tools from './tools';
import { logger } from './common';
import type { FunctionCall, LinkedTaskCompletion, Message, MessagePart, Session, ToolScriptSubCall } from './types';
import * as sessionManager from './sessionManager';
import type { CurrentSessionEffects } from './session/currentSessionEffects';
import { HANDOFF_CONFIRMATION_ENABLED } from './config';
import { checkGenericToolAuthorizationForSession } from './isolatedCheck';
import type { ResolvedTool } from './tools/resolvedTools';
import { executeResolvedTool, parseUnifiedToolCall, resolveDirectTool, resolvedToolAuthorizationSession } from './tools/resolvedTools';
import { normalizeToolResultImages } from './toolImages';
import { guardToolOutputForModel } from './toolOutputGuard';
import { isToolAuthorizationPolicyUnavailable, TOOL_AUTH_POLICY_UNAVAILABLE } from './toolAuthorization';
import { formatLocalTimestamp } from './utils/localTime';
import {
    STOPPED_TOOL_NOT_STARTED_MESSAGE,
    toolNotStartedMessage,
    getToolCancellationArgumentError,
    isSingleToolCancellationRequested,
    isWholeBatchCancellationRequested,
    stripToolCancellationArguments,
    validateInterAgentHandoffConfirmationForMode,
} from './toolCallControls';

/** Canonical history and transient turn actions have separate owners and lifetimes. */
export interface ToolBatchResult {
    message: Message;
    control?: {
        stopCurrentTurn: true;
        fatalError?: { code: string; message: string };
    };
    postActions?: {
        completedLinkedTask?: LinkedTaskCompletion;
        waitForReply?: true;
        finishAfterSend?: true;
        successfulSendToSessionTargets?: string[];
        successfulWaitAfterSendTargets?: string[];
    };
}

function buildInvalidToolArgsResult(call: FunctionCall): { error: { type: string; message: string } } {
    // Do NOT send rawArgsText in the tool response — the call's arguments
    // already carry it, so no need to duplicate.
    return {
        error: {
            type: 'invalid_tool_arguments',
            message: call.argsParseError || 'Invalid tool arguments JSON',
        }
    };
}

const PARALLEL_EXEC_LIMIT = 4;

type ToolExecutionSnapshot = {
    currentNode: string;
    cwd?: string;
};

type PreparedToolCall = {
    call: FunctionCall;
    index: number;
    toolId: string;
    resolved?: ResolvedTool;
    toolArgs: Record<string, any>;
    sessionId: string;
    executionNode: string;
    result?: any;
    sessionSnapshot?: ToolExecutionSnapshot;
    placementError?: any;
};

type ExecutedToolCall = PreparedToolCall & {
    result: any;
    executionTiming?: { startedAt: number; completedAt: number; durationMs: number };
    resolvedPaths?: Array<{ raw: string; resolved: string; nodeId: string }>;
    toolScriptSubCalls?: ToolScriptSubCall[];
    sessionMessages?: NonNullable<FunctionResponse["__meta"]>["sessionMessages"];
    imageParts: MessagePart[];
    stopCurrentTurn: boolean;
    waitForReply: boolean;
    explicitWaitId?: string;
    successfulSendToSessionTarget?: string;
    successfulWaitAfterSendTarget?: string;
    successfulFinishAfterSend: boolean;
    completedLinkedTask?: LinkedTaskCompletion;
    deferredExecCwdSync?: { nextCwd: string; nodeId?: string };
    fatalCurrentTurn?: { code: string; message: string };
};

function normalizeExecutedToolResult(rawResult: any): any {
    if (rawResult === undefined) return { output: '(No output)' };
    if (rawResult === null) return { output: null };
    if (typeof rawResult === 'string' || typeof rawResult === 'number' || typeof rawResult === 'boolean') {
        return { output: rawResult };
    }
    if (typeof rawResult === 'object') return rawResult;
    return { output: String(rawResult) };
}

function formatToolArgPreviewValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : String(value);
    } catch {
        return String(value);
    }
}

function buildToolArgsPreview(call: FunctionCall): string {
    let argValue: unknown = '';
    if (call.argsParseError && typeof call.rawArgsText === 'string') {
        argValue = call.rawArgsText;
    } else if (call.name === 'exec') {
        argValue = call.args?.command;
    } else if (call.name === 'edit' && typeof call.args?.apply_patch === 'string') {
        argValue = call.args.apply_patch;
    } else if (call.name === 'edit' || call.name === 'write' || call.name === 'edit_memory' || call.name === 'write_memory' || call.name === 'delete_memory') {
        argValue = call.args?.filePath;
    } else if (call.name === 'apply_patch' || call.name === 'apply_patch_memory') {
        argValue = typeof call.args?.input === 'string' ? call.args.input : '';
    } else if (call.name === 'read' || call.name === 'read_memory') {
        const { filePath, startLine, endLine } = call.args || {};
        argValue = (filePath ?? '') + (startLine ? ` (lines ${startLine}-${endLine})` : '');
    } else if (call.args) {
        const keys = Object.keys(call.args);
        if (keys.length === 1) {
            argValue = call.args[keys[0]];
        } else {
            argValue = keys.map(key => `${key}: ${formatToolArgPreviewValue(call.args[key])}`).join('\n');
        }
    }
    const argStr = formatToolArgPreviewValue(argValue);
    return argStr.length > 200 ? `${argStr.substring(0, 197)}...` : argStr;
}

async function prepareToolCall(
    call: FunctionCall,
    index: number,
    total: number,
    toolContext: any,
    session: Session,
    snapshot?: ToolExecutionSnapshot,
    notifyStart = true,
    presetResult?: any,
): Promise<PreparedToolCall> {
    if (presetResult === undefined && (toolContext.signal?.aborted || session.stopping)) {
        presetResult = { error: toolNotStartedMessage(toolContext.signal) };
    }
    const toolId = call.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const argsPreview = buildToolArgsPreview(call);
    const sessionId = session.id;
    let placementError: any;
    let resolved: ResolvedTool | undefined;
    if (presetResult === undefined) {
        try {
            if (call.argsParseError) tools.assertToolAvailableForPlacement(call.name, call.args || {}, toolContext);
            else {
                resolved = await resolveDirectTool(call.name, call.args || {}, toolContext, snapshot);
                const permissionIdentity = resolved.source === 'node'
                    ? { source: 'node' as const, node: resolved.executionNode, tool: resolved.name }
                    : resolved.source === 'mcp'
                        ? { source: 'mcp' as const, server: resolved.server, tool: resolved.name }
                        : { source: 'builtin' as const, tool: resolved.name };
                await checkGenericToolAuthorizationForSession(resolvedToolAuthorizationSession(resolved, session), permissionIdentity, resolved.permissionNode, resolved.args,
                    toolContext.sessionPlacement === 'session-worker');
            }
        } catch (error) { placementError = error; }
    }
    if (presetResult === undefined && (toolContext.signal?.aborted || session.stopping)) {
        presetResult = { error: toolNotStartedMessage(toolContext.signal) };
    }
    const toolArgs = resolved?.args || { ...(call.args || {}) };
    const executionNode = resolved?.executionNode || snapshot?.currentNode || session.currentNode || 'master';
    if (notifyStart && !placementError && presetResult === undefined) {
        logger.info({ tool: call.name, args: argsPreview }, 'Executing tool');
        if (toolContext.broadcast && session.verbose) {
            toolContext.broadcast(`🛠 *[${call.name}]*: \`${argsPreview}\``, { excludePlatforms: ['webui'] });
        }
        const startedAt = Date.now();
        await Promise.resolve(toolContext.onToolStart?.({
            id: toolId,
            name: resolved?.name || call.name,
            ...(resolved ? { source: resolved.source, ...(resolved.server ? { server: resolved.server } : {}) } : {}),
            ...(resolved?.name && resolved.name !== call.name ? { invocationName: call.name } : {}),
            ...(resolved?.source === 'builtin' && resolved.name === 'node' && typeof resolved.args.action === 'string' ? { action: resolved.args.action.slice(0, 64) } : {}),
            ...(resolved?.source === 'node' && resolved.name === 'read' && typeof resolved.args.filePath === 'string' ? { target: resolved.args.filePath.split(/[\\/]/).at(-1)!.slice(0, 160) } : {}),
            index,
            total,
            executionNode,
            argsPreview: resolved ? buildToolArgsPreview({ ...call, name: resolved.name, args: resolved.args }) : argsPreview,
            startedAt,
        }));
    }

    return {
        call,
        index,
        toolId,
        resolved,
        toolArgs,
        sessionId,
        executionNode,
        result: presetResult !== undefined ? presetResult : (call.argsParseError ? buildInvalidToolArgsResult(call) : undefined),
        sessionSnapshot: resolved?.routingSnapshot,
        placementError,
    };
}

function buildCanceledToolResult(): { canceled: true; message: string } {
    return { canceled: true, message: 'Tool call canceled before execution.' };
}

function buildToolControlArgumentError(message: string): { error: { type: string; message: string } } {
    return { error: { type: 'invalid_tool_control_argument', message } };
}

function buildHandoffConfirmationError(error: any): { error: { type: string; message: string } } {
    return {
        error: {
            type: 'invalid_inter_agent_handoff_confirmation',
            message: error?.message || String(error),
        },
    };
}

type PlannedToolCall = {
    call: FunctionCall;
    presetResult?: any;
};

function planToolCalls(functionCalls: FunctionCall[]): PlannedToolCall[] {
    if (isWholeBatchCancellationRequested(functionCalls)) {
        return functionCalls.map(call => ({
            call: { ...call, args: stripToolCancellationArguments(call.args) },
            presetResult: buildCanceledToolResult(),
        }));
    }

    return functionCalls.map(call => {
        const executionCall = { ...call, args: stripToolCancellationArguments(call.args) };
        const controlError = getToolCancellationArgumentError(call);
        if (controlError) return { call: executionCall, presetResult: buildToolControlArgumentError(controlError) };
        if (isSingleToolCancellationRequested(call)) return { call: executionCall, presetResult: buildCanceledToolResult() };
        if (!call.argsParseError && (call.name === 'send_to_session' || call.name === 'create_child_session')) {
            try {
                validateInterAgentHandoffConfirmationForMode(executionCall.args, HANDOFF_CONFIRMATION_ENABLED, call.name);
            } catch (error) {
                return { call: executionCall, presetResult: buildHandoffConfirmationError(error) };
            }
        }
        return { call: executionCall };
    });
}

async function runPreparedToolCall(prepared: PreparedToolCall, toolContext: any): Promise<ExecutedToolCall> {
    let result = prepared.result;
    let executionTiming: ExecutedToolCall['executionTiming'];
    let resolvedPaths: ExecutedToolCall['resolvedPaths'];
    let toolScriptSubCalls: ToolScriptSubCall[] | undefined;
    let sessionMessages: NonNullable<FunctionResponse["__meta"]>["sessionMessages"];
    let imageParts: MessagePart[] = [];
    let stopCurrentTurn = false;
    let waitForReply = false;
    let explicitWaitId: string | undefined;
    let successfulSendToSessionTarget: string | undefined;
    let successfulWaitAfterSendTarget: string | undefined;
    let successfulFinishAfterSend = false;
    let completedLinkedTask: LinkedTaskCompletion | undefined;
    let deferredExecCwdSync: { nextCwd: string; nodeId?: string } | undefined;
    let fatalCurrentTurn: { code: string; message: string } | undefined;

    try {
        if (prepared.placementError) throw prepared.placementError;
        if (result === undefined && (toolContext.signal?.aborted || toolContext.session?.stopping)) {
            return buildSkippedToolCall(prepared, toolNotStartedMessage(toolContext.signal));
        }
        if (result === undefined && prepared.resolved) {
            const runtimeContext = { ...toolContext, toolUseId: prepared.toolId };
            const localToolContext = prepared.sessionSnapshot
                ? {
                    ...runtimeContext,
                    toolExecutionSnapshot: prepared.sessionSnapshot,
                    deferSessionCwdSync: prepared.call.name === 'exec',
                }
                : runtimeContext;
            const startedAt = Date.now();
            const monotonicStart = performance.now();
            try {
                const isToolScriptExecution = prepared.resolved.source === 'builtin'
                    && ['run_script', 'continue_script', 'start_toolscript_run'].includes(prepared.resolved.name);
                result = normalizeExecutedToolResult(await executeResolvedTool(prepared.resolved, {
                    ...localToolContext,
                    ...(prepared.resolved.source === 'builtin' && prepared.resolved.name === 'send_to_session' ? {
                        onSessionMessageDelivered: (delivery: {targetSessionId:string;message:string}) => {
                            sessionMessages = [{id:prepared.toolId,targetSessionId:delivery.targetSessionId,message:delivery.message.slice(0,32768),
                                ...(delivery.message.length > 32768 ? {truncated:true} : {})}];
                        },
                    } : {}),
                    ...(isToolScriptExecution ? { onToolScriptSubCalls: (subCalls: ToolScriptSubCall[]) => {
                        toolScriptSubCalls = subCalls.map(subCall => ({ ...subCall }));
                    } } : {}),
                    onResolvedPaths: (paths: Array<{ raw: string; resolved: string }>) => {
                        resolvedPaths = paths.map(path => ({ ...path, nodeId: prepared.resolved!.executionNode }));
                    },
                }));
            } finally {
                executionTiming = {
                    startedAt,
                    completedAt: Math.max(startedAt, Date.now()),
                    durationMs: Math.max(0, performance.now() - monotonicStart),
                };
            }
        } else if (result === undefined) {
            result = { error: `Unknown tool: ${prepared.call.name}` };
        }

        if (result && typeof result === 'object') {
            if (result.__toolLoopControl && typeof result.__toolLoopControl === 'object') {
                stopCurrentTurn = !!result.__toolLoopControl.stopCurrentTurn;
            }
            if (result.__toolPostAction && typeof result.__toolPostAction === 'object') {
                const taskCall = prepared.resolved?.source === 'builtin' && prepared.resolved.name === 'task';
                const taskScriptCall = prepared.resolved?.source === 'builtin' && ['run_script', 'continue_script', 'start_toolscript_run'].includes(prepared.resolved.name);
                const completion = result.__toolPostAction.completedLinkedTask;
                if ((taskCall || taskScriptCall) && completion?.attachedSessionId === prepared.sessionId) completedLinkedTask = completion;
                waitForReply = result.__toolPostAction.waitForReply === true;
                explicitWaitId = typeof result.__toolPostAction.explicitWaitId === 'string'
                    ? result.__toolPostAction.explicitWaitId
                    : undefined;
                successfulSendToSessionTarget = (prepared.call.name === 'send_to_session' || prepared.call.name === 'create_child_session' || taskCall)
                    && typeof result.__toolPostAction.successfulSendToSessionTarget === 'string'
                    ? result.__toolPostAction.successfulSendToSessionTarget
                    : undefined;
                successfulWaitAfterSendTarget = successfulSendToSessionTarget
                    && (prepared.call.args?.afterSend === 'wait' || prepared.call.args?.waitAfterHandoff === true)
                    && waitForReply
                    ? successfulSendToSessionTarget : undefined;
                successfulFinishAfterSend = (prepared.call.name === 'send_to_session' || prepared.call.name === 'create_child_session')
                    && result.__toolPostAction.finishAfterSend === true;
            }
            if (result.__execBatchCwdSync && typeof result.__execBatchCwdSync.nextCwd === 'string') {
                deferredExecCwdSync = { nextCwd: result.__execBatchCwdSync.nextCwd,
                    ...(typeof result.__execBatchCwdSync.nodeId === 'string' ? { nodeId: result.__execBatchCwdSync.nodeId } : {}) };
            }
            const actualArgs = prepared.resolved?.args || prepared.call.args;
            if (!sessionMessages && prepared.resolved?.source === 'builtin' && prepared.resolved.name === 'send_to_session'
                && typeof result.__toolPostAction?.successfulSendToSessionTarget === 'string' && typeof actualArgs?.message === 'string') {
                sessionMessages = [{ id: prepared.toolId, targetSessionId: result.__toolPostAction.successfulSendToSessionTarget,
                    message: actualArgs.message.slice(0, 32768), ...(actualArgs.message.length > 32768 ? { truncated: true } : {}) }];
            }
            const { __toolLoopControl, __toolPostAction, __execBatchCwdSync, ...visibleResult } = result;
            result = visibleResult;
        }

        const normalizedImages = await normalizeToolResultImages(
            result,
            prepared.toolId,
            `[Inline data returned by ${prepared.call.name}]`,
        );
        imageParts = normalizedImages.imageParts;
        result = normalizedImages.result;
    } catch (error: any) {
        if (isToolAuthorizationPolicyUnavailable(error)) {
            fatalCurrentTurn = { code: TOOL_AUTH_POLICY_UNAVAILABLE, message: error?.message || 'Tool authorization policy is unavailable.' };
        }
        result = { error: error?.message || String(error), ...(error?.code ? { code: error.code } : {}),
            ...(error?.retryable === true ? { retryable: true } : {}) };
        imageParts = [];
        resolvedPaths = undefined;
    }

    return {
        ...prepared,
        result: normalizeExecutedToolResult(result),
        ...(executionTiming ? { executionTiming } : {}),
        ...(resolvedPaths?.length ? { resolvedPaths } : {}),
        ...(toolScriptSubCalls !== undefined ? { toolScriptSubCalls } : {}),
        ...(sessionMessages ? { sessionMessages } : {}),
        imageParts,
        stopCurrentTurn,
        waitForReply,
        explicitWaitId,
        successfulSendToSessionTarget,
        successfulWaitAfterSendTarget,
        successfulFinishAfterSend,
        completedLinkedTask,
        deferredExecCwdSync,
        fatalCurrentTurn,
    };
}

async function runBoundedToolCalls(
    planned: PlannedToolCall[],
    toolContext: any,
    session: Session,
    snapshot: ToolExecutionSnapshot,
    offset: number,
    total: number,
): Promise<ExecutedToolCall[]> {
    const results: ExecutedToolCall[] = new Array(planned.length);
    let nextIndex = 0;
    let fatal = false;
    const workers = Array.from({ length: Math.min(PARALLEL_EXEC_LIMIT, planned.length) }, async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= planned.length) return;
            const item = planned[index];
            const prepared = await prepareToolCall(item.call, offset + index, total, toolContext, session, snapshot, true, item.presetResult
                ?? (fatal ? { error: 'Tool call was not started because tool authorization policy was unavailable.' } : undefined));
            try {
                results[index] = await runPreparedToolCall(prepared, toolContext);
                fatal = fatal || !!results[index].fatalCurrentTurn;
            } catch (error: any) {
                results[index] = buildFailedToolCall(prepared, error);
                fatal = fatal || !!results[index].fatalCurrentTurn;
            }
        }
    });
    await Promise.allSettled(workers);
    return results;
}

function buildFailedToolCall(prepared: PreparedToolCall, error: any): ExecutedToolCall {
    return {
        ...prepared,
        result: { error: error?.message || String(error) },
        imageParts: [],
        stopCurrentTurn: false,
        waitForReply: false,
        successfulFinishAfterSend: false,
        ...(isToolAuthorizationPolicyUnavailable(error) ? {
            fatalCurrentTurn: { code: TOOL_AUTH_POLICY_UNAVAILABLE, message: error?.message || 'Tool authorization policy is unavailable.' },
        } : {}),
    };
}

function buildSkippedToolCall(prepared: PreparedToolCall, message = STOPPED_TOOL_NOT_STARTED_MESSAGE): ExecutedToolCall {
    return {
        ...prepared,
        result: { error: message },
        imageParts: [],
        stopCurrentTurn: false,
        waitForReply: false,
        successfulFinishAfterSend: false,
    };
}

function isFailedNodeSelection(execution: ExecutedToolCall, planned: PlannedToolCall): boolean {
    if (planned.presetResult !== undefined || !execution.result?.error) return false;
    try {
        // Resolution itself can reject arguments before returning a target.
        // Reuse the canonical unified parser, without resolving or executing again.
        const target = execution.resolved || (execution.call.name === 'call_tool'
            ? parseUnifiedToolCall(execution.call.args || {})
            : { source: 'builtin', name: execution.call.name, args: execution.call.args || {} });
        return target.source === 'builtin' && target.name === 'node'
            && typeof target.args.action === 'string' && target.args.action.trim().toLowerCase() === 'select';
    } catch { return false; }
}

async function replayDeferredExecCwd(execution: ExecutedToolCall, toolContext: any): Promise<ExecutedToolCall> {
    if (!execution.deferredExecCwdSync) return execution;
    try {
        const { applyDeferredExecCwdSync } = await import('./tools/execTools');
        return {
            ...execution,
            result: await applyDeferredExecCwdSync(toolContext, execution.result, execution.deferredExecCwdSync),
            deferredExecCwdSync: undefined,
        };
    } catch (error: any) {
        return {
            ...execution,
            result: { error: error?.message || String(error) },
            deferredExecCwdSync: undefined,
        };
    }
}

/**
 * Execute one model-returned batch, separating canonical results from turn actions.
 * Adjacent direct exec calls share a node/cwd snapshot and run concurrently;
 * every other tool is a serial ordering barrier.
 */
export async function executeTools(
    functionCalls: FunctionCall[],
    toolContext: any,
    session: any,
    options?: { currentSessionEffects?: CurrentSessionEffects },
): Promise<ToolBatchResult> {
    const requestedSourceId = typeof toolContext?.sessionId === 'string' && toolContext.sessionId.trim()
        ? toolContext.sessionId.trim()
        : undefined;
    let sourceSession: Session;
    if (options?.currentSessionEffects) {
        if (!session || typeof session.id !== 'string' || !session.id.trim()) {
            throw new Error('Tool execution with current-session effects requires an authoritative Session.');
        }
        if (requestedSourceId && requestedSourceId !== session.id) {
            throw new Error(`Tool execution source session \`${requestedSourceId}\` does not match authoritative Session \`${session.id}\`.`);
        }
        sourceSession = session;
    } else {
        if (!requestedSourceId) {
            throw new Error('Tool execution requires a source session ID when current-session effects are absent.');
        }
        const existing = await sessionManager.getExistingSession(requestedSourceId);
        if (!existing) {
            throw new Error(`Tool execution source session \`${requestedSourceId}\` was not found.`);
        }
        sourceSession = existing;
    }
    toolContext = {
        ...toolContext,
        sessionId: sourceSession.id,
        session: sourceSession,
        persistCurrentSession: options?.currentSessionEffects
            ? () => options.currentSessionEffects!.persistSession(sourceSession)
            : undefined,
        sessionPlacement: options?.currentSessionEffects?.placement || 'local',
        ...(options?.currentSessionEffects?.execRuntime ? { execRuntime: options.currentSessionEffects.execRuntime } : {}),
    };
    const abortController = new AbortController();
    const parentSignal: AbortSignal | undefined = toolContext.signal;
    const abortFromParent = () => abortController.abort(parentSignal?.reason);
    if (parentSignal?.aborted || sourceSession.stopping) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const effects = options?.currentSessionEffects;
    if (effects) effects.registerAbortController(sourceSession.id, abortController);
    else sessionManager.registerSessionAbortController(sourceSession.id, abortController);
    toolContext = { ...toolContext, signal: abortController.signal };
    try {
        return await executeToolBatch(functionCalls, toolContext, sourceSession, effects);
    } finally {
        parentSignal?.removeEventListener('abort', abortFromParent);
        if (effects) effects.clearAbortController(sourceSession.id, abortController);
        else sessionManager.clearSessionAbortController(sourceSession.id, abortController);
    }
}

async function executeToolBatch(
    functionCalls: FunctionCall[],
    toolContext: any,
    session: Session,
    effects?: CurrentSessionEffects,
): Promise<ToolBatchResult> {
    const plannedCalls = planToolCalls(functionCalls);
    const executions: ExecutedToolCall[] = [];
    let cursor = 0;
    let fatalCurrentTurn = false;

    while (cursor < plannedCalls.length) {
        if (session?.stopping || toolContext.signal.aborted) {
            for (; cursor < plannedCalls.length; cursor++) {
                const planned = plannedCalls[cursor];
                const prepared = await prepareToolCall(planned.call, cursor, plannedCalls.length, toolContext, session, undefined, false, planned.presetResult ?? { error: toolNotStartedMessage(toolContext.signal) });
                executions.push(planned.presetResult !== undefined
                    ? await runPreparedToolCall(prepared, toolContext)
                    : buildSkippedToolCall(prepared, toolNotStartedMessage(toolContext.signal)));
            }
            break;
        }

        if (plannedCalls[cursor].call.name !== 'exec') {
            const planned = plannedCalls[cursor];
            const prepared = await prepareToolCall(planned.call, cursor, plannedCalls.length, toolContext, session, undefined, true, planned.presetResult);
            const execution = await runPreparedToolCall(prepared, toolContext);
            executions.push(execution);
            cursor++;
            if (isFailedNodeSelection(execution, planned)) {
                fatalCurrentTurn = !!execution.fatalCurrentTurn;
                const message = 'Tool call was not started because Node selection failed earlier in this batch.';
                for (; cursor < plannedCalls.length; cursor++) {
                    const skipped = plannedCalls[cursor];
                    const skippedPrepared = await prepareToolCall(skipped.call, cursor, plannedCalls.length, toolContext, session,
                        undefined, false, skipped.presetResult ?? { error: message });
                    executions.push(skipped.presetResult !== undefined
                        ? await runPreparedToolCall(skippedPrepared, toolContext)
                        : buildSkippedToolCall(skippedPrepared, message));
                }
                break;
            }
            if (execution.fatalCurrentTurn) {
                fatalCurrentTurn = true;
                for (; cursor < plannedCalls.length; cursor++) {
                    const skipped = plannedCalls[cursor];
                    const skippedPrepared = await prepareToolCall(skipped.call, cursor, plannedCalls.length, toolContext, session, undefined, false, skipped.presetResult);
                    executions.push(skipped.presetResult !== undefined
                        ? await runPreparedToolCall(skippedPrepared, toolContext)
                        : buildSkippedToolCall(skippedPrepared, 'Tool call was not started because tool authorization policy was unavailable.'));
                }
                break;
            }
            continue;
        }

        const segmentStart = cursor;
        while (cursor < plannedCalls.length && plannedCalls[cursor].call.name === 'exec') cursor++;
        const snapshot: ToolExecutionSnapshot = {
            currentNode: session.currentNode || 'master',
            cwd: typeof session.cwd === 'string' ? session.cwd : undefined,
        };
        const settled = await runBoundedToolCalls(plannedCalls.slice(segmentStart, cursor), toolContext,
            session, snapshot, segmentStart, plannedCalls.length);
        for (const execution of settled) {
            executions.push(await replayDeferredExecCwd(execution, toolContext));
        }
        if (settled.some(execution => execution.fatalCurrentTurn)) {
            fatalCurrentTurn = true;
            for (; cursor < plannedCalls.length; cursor++) {
                const skipped = plannedCalls[cursor];
                const skippedPrepared = await prepareToolCall(skipped.call, cursor, plannedCalls.length, toolContext, session, undefined, false, skipped.presetResult);
                executions.push(skipped.presetResult !== undefined
                    ? await runPreparedToolCall(skippedPrepared, toolContext)
                    : buildSkippedToolCall(skippedPrepared, 'Tool call was not started because tool authorization policy was unavailable.'));
            }
            break;
        }
    }

    const parts: MessagePart[] = [];
    let stopCurrentTurn = false;
    let batchHasError = false;
    let waitForReply = false;
    const explicitWaitIds: string[] = [];
    let completedLinkedTask: LinkedTaskCompletion | undefined;
    const successfulSendToSessionTargets: string[] = [];
    const successfulWaitAfterSendTargets: string[] = [];
    let successfulFinishAfterSend = false;
    let fatalError: { code: string; message: string } | undefined;

    for (const execution of executions) {
        let result = execution.result;
        try {
            result = await guardToolOutputForModel(result, {
                sessionId: execution.sessionId,
                session,
                toolName: execution.call.name,
                toolUseId: execution.toolId,
                nodeId: execution.executionNode,
                toolScriptExecution: execution.toolScriptSubCalls !== undefined,
            });
        } catch (error: any) {
            result = { error: error?.message || String(error) };
        }
        const resolvedPaths = !result?.error && execution.resolvedPaths?.length ? execution.resolvedPaths : undefined;
        parts.push(...execution.imageParts, {
            functionResponse: {
                tool_use_id: execution.toolId,
                name: execution.call.name,
                ...(execution.executionTiming ? { executionTiming: execution.executionTiming } : {}),
                ...(resolvedPaths || execution.toolScriptSubCalls !== undefined || execution.sessionMessages ? { __meta: {
                    ...(resolvedPaths ? { resolvedPaths } : {}),
                    ...(execution.sessionMessages ? { sessionMessages: execution.sessionMessages } : {}),
                    ...(execution.toolScriptSubCalls !== undefined ? { toolScriptSubCalls: execution.toolScriptSubCalls } : {}),
                } } : {}),
                ...(execution.index === 0 && toolContext.previousLlmRequest ? {
                    previousLlmRequest: {
                        time: formatLocalTimestamp(toolContext.previousLlmRequest.completedAt),
                        durationMs: toolContext.previousLlmRequest.durationMs,
                    },
                } : {}),
                response: result,
            },
        });
        stopCurrentTurn = stopCurrentTurn || execution.stopCurrentTurn;
        batchHasError = batchHasError || !!(result && typeof result === 'object' && result.error !== undefined && result.error !== null);
        waitForReply = waitForReply || execution.waitForReply;
        if (execution.explicitWaitId) explicitWaitIds.push(execution.explicitWaitId);
        if (execution.successfulSendToSessionTarget) successfulSendToSessionTargets.push(execution.successfulSendToSessionTarget);
        if (execution.successfulWaitAfterSendTarget && !successfulWaitAfterSendTargets.includes(execution.successfulWaitAfterSendTarget)) {
            successfulWaitAfterSendTargets.push(execution.successfulWaitAfterSendTarget);
        }
        successfulFinishAfterSend = successfulFinishAfterSend || execution.successfulFinishAfterSend;
        completedLinkedTask = completedLinkedTask || execution.completedLinkedTask;
        fatalError = fatalError || execution.fatalCurrentTurn;
    }

    if (stopCurrentTurn && batchHasError) {
        for (const waitId of explicitWaitIds) {
            if (effects) {
                await effects.clearWaitById(toolContext.sessionId || session?.id, waitId);
            } else {
                await sessionManager.clearSessionWaitById(toolContext.sessionId || session?.id, waitId);
            }
        }
    }

    const batchResult: ToolBatchResult = { message: { role: 'tool', parts } };
    if (fatalCurrentTurn && fatalError) {
        batchResult.control = { stopCurrentTurn: true, fatalError };
    } else if ((stopCurrentTurn && !batchHasError) || successfulFinishAfterSend) {
        batchResult.control = { stopCurrentTurn: true };
    } else if (stopCurrentTurn) {
        logger.debug({ sessionId: toolContext.sessionId || session?.id, toolCount: functionCalls.length }, 'Suppressing stopCurrentTurn because a tool in the batch returned an error');
    }
    if (waitForReply || successfulFinishAfterSend || completedLinkedTask || successfulSendToSessionTargets.length || successfulWaitAfterSendTargets.length) {
        batchResult.postActions = {
            ...(completedLinkedTask ? { completedLinkedTask } : {}),
            ...(waitForReply ? { waitForReply: true } : {}),
            ...(successfulFinishAfterSend ? { finishAfterSend: true } : {}),
            ...(successfulSendToSessionTargets.length ? { successfulSendToSessionTargets } : {}),
            ...(successfulWaitAfterSendTargets.length ? { successfulWaitAfterSendTargets } : {}),
        };
    }
    return batchResult;
}
