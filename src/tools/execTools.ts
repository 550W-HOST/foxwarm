import {
    ToolArgs,
    ToolContext,
} from './helpers';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { resolveExecTimeoutSeconds } from '../../packages/shared/dist/persistentExec';
import {
    buildBackgroundTimeoutResult,
    buildForegroundExecResult,
    finalizeForegroundExec,
    markExecForBackgroundNotification,
    readFinishedExecWorkingDirectory,
    readLiveExecWorkingDirectory,
    startPersistentExec,
    waitForExecCompletion,
} from '../execManager';

export interface DeferredExecCwdSync {
    nextCwd: string;
}

async function maybeSyncSessionCwdFromExec(ctx: ToolContext, entry: { initialCwd?: string }, nextCwd: string | null | undefined): Promise<string | null> {
    if (!ctx.sessionId || typeof nextCwd !== 'string' || nextCwd.trim().length === 0) {
        return null;
    }

    const normalizedNext = nextCwd.trim();
    const normalizedInitial = typeof entry.initialCwd === 'string' ? entry.initialCwd.trim() : '';
    if (normalizedInitial && normalizedNext === normalizedInitial) {
        return null;
    }

    const syncResult = await sessionRuntime.updateSettings(ctx.sessionId, { cwd: normalizedNext });
    if (!syncResult.changed.includes('cwd') || !syncResult.current.cwd) {
        return null;
    }

    const defaultNote = 'This cwd will be used as the default cwd for subsequent exec/read/edit/write/apply_patch tool calls.';
    if (syncResult.previous.cwd) {
        return `SESSION CWD CHANGED: \`${syncResult.previous.cwd}\` → \`${syncResult.current.cwd}\`. ${defaultNote}`;
    }

    return `SESSION CWD CHANGED: \`${syncResult.current.cwd}\`. ${defaultNote}`;
}

function appendCwdNotice(result: string, cwdNotice: string | null): string {
    return cwdNotice ? `${result}\n\n${cwdNotice}` : result;
}

export async function applyDeferredExecCwdSync(
    sessionId: string,
    result: any,
    cwdSync: DeferredExecCwdSync,
): Promise<any> {
    const syncResult = await sessionRuntime.updateSettings(sessionId, { cwd: cwdSync.nextCwd });
    if (!syncResult.changed.includes('cwd') || !syncResult.current.cwd) {
        return result;
    }
    const defaultNote = 'This cwd will be used as the default cwd for subsequent exec/read/edit/write/apply_patch tool calls.';
    const notice = syncResult.previous.cwd
        ? `SESSION CWD CHANGED: \`${syncResult.previous.cwd}\` → \`${syncResult.current.cwd}\`. ${defaultNote}`
        : `SESSION CWD CHANGED: \`${syncResult.current.cwd}\`. ${defaultNote}`;
    if (typeof result === 'object' && result !== null && typeof result.output === 'string') {
        return { ...result, output: appendCwdNotice(result.output, notice) };
    }
    return { output: appendCwdNotice(String(result?.output ?? result ?? '(No output)'), notice) };
}

export async function tool_exec(args: ToolArgs, ctx: ToolContext) {
    const { command, cwd, timeout } = args;
    const resolvedTimeout = resolveExecTimeoutSeconds(timeout);
    const timeoutSeconds = resolvedTimeout.effectiveSeconds;

    // Mark that we're about to exec, then save session
    if (ctx && ctx.sessionId) {
        await sessionManager.saveSession(ctx.sessionId);
    }

    const agentName = ctx.session?.agent || 'main';
    const nodeId = ctx.runtimeNodeId || 'master';
    const execEntry = await startPersistentExec({
        command,
        sessionId: ctx.sessionId,
        agentName,
        nodeId,
        cwd,
        sessionCwd: ctx.toolExecutionSnapshot?.cwd ?? ctx.session?.cwd,
    });

    const status = await waitForExecCompletion(execEntry.id, timeoutSeconds * 1000);
    if (status) {
        try {
            const nextCwd = await readFinishedExecWorkingDirectory(execEntry);
            const result = await buildForegroundExecResult(execEntry, status, resolvedTimeout.warning);
            if (ctx.deferSessionCwdSync && typeof nextCwd === 'string' && nextCwd.trim()) {
                return { output: result, __execBatchCwdSync: { nextCwd: nextCwd.trim() } };
            }
            const cwdNotice = await maybeSyncSessionCwdFromExec(ctx, execEntry, nextCwd);
            return appendCwdNotice(result, cwdNotice);
        } finally {
            await finalizeForegroundExec(execEntry.id);
        }
    }

    const nextCwd = await readLiveExecWorkingDirectory(execEntry);
    await markExecForBackgroundNotification(execEntry.id);
    const result = await buildBackgroundTimeoutResult(execEntry, timeoutSeconds, resolvedTimeout.warning);
    if (ctx.deferSessionCwdSync && typeof nextCwd === 'string' && nextCwd.trim()) {
        return { output: result, __execBatchCwdSync: { nextCwd: nextCwd.trim() } };
    }
    const cwdNotice = await maybeSyncSessionCwdFromExec(ctx, execEntry, nextCwd);
    return appendCwdNotice(result, cwdNotice);
}
