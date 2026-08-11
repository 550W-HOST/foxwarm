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
    type ExecRuntime,
} from '../execManager';

export interface DeferredExecCwdSync {
    nextCwd: string;
}

type ExecToolRuntime = Pick<ExecRuntime,
    'startPersistentExec' | 'waitForExecCompletion' | 'markExecForBackgroundNotification'
    | 'finalizeForegroundExec' | 'buildForegroundExecResult' | 'buildBackgroundTimeoutResult'
    | 'readFinishedExecWorkingDirectory' | 'readLiveExecWorkingDirectory'>;

async function syncSessionCwd(ctx: ToolContext, nextCwd: string | null | undefined): Promise<string | null> {
    const normalizedNext = typeof nextCwd === 'string' && nextCwd.trim() ? nextCwd.trim() : null;
    const trustedSession = ctx.persistCurrentSession && ctx.session?.id === ctx.sessionId ? ctx.session : undefined;
    if (trustedSession) {
        const previous = typeof trustedSession.cwd === 'string' && trustedSession.cwd.trim() ? trustedSession.cwd.trim() : null;
        if (normalizedNext === null) delete trustedSession.cwd;
        else trustedSession.cwd = normalizedNext;
        if (previous !== normalizedNext) await ctx.persistCurrentSession!();
        if (previous === normalizedNext || normalizedNext === null) return null;
        const defaultNote = 'This cwd will be used as the default cwd for subsequent exec/read/edit/write/apply_patch tool calls.';
        return previous
            ? `SESSION CWD CHANGED: \`${previous}\` → \`${normalizedNext}\`. ${defaultNote}`
            : `SESSION CWD CHANGED: \`${normalizedNext}\`. ${defaultNote}`;
    }
    if (!ctx.sessionId) return null;
    const syncResult = await sessionRuntime.updateSettings(ctx.sessionId, { cwd: normalizedNext });
    if (!syncResult.changed.includes('cwd') || !syncResult.current.cwd) return null;
    const defaultNote = 'This cwd will be used as the default cwd for subsequent exec/read/edit/write/apply_patch tool calls.';
    return syncResult.previous.cwd
        ? `SESSION CWD CHANGED: \`${syncResult.previous.cwd}\` → \`${syncResult.current.cwd}\`. ${defaultNote}`
        : `SESSION CWD CHANGED: \`${syncResult.current.cwd}\`. ${defaultNote}`;
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

    return syncSessionCwd(ctx, normalizedNext);
}

function appendCwdNotice(result: string, cwdNotice: string | null): string {
    return cwdNotice ? `${result}\n\n${cwdNotice}` : result;
}

export async function applyDeferredExecCwdSync(
    ctx: ToolContext,
    result: any,
    cwdSync: DeferredExecCwdSync,
): Promise<any> {
    const notice = await syncSessionCwd(ctx, cwdSync.nextCwd);
    if (!notice) return result;
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
        if (ctx.persistCurrentSession && ctx.session?.id === ctx.sessionId) await ctx.persistCurrentSession();
        else await sessionManager.saveSession(ctx.sessionId);
    }

    const runtime: ExecToolRuntime = ctx.execRuntime || {
        startPersistentExec,
        waitForExecCompletion,
        markExecForBackgroundNotification,
        finalizeForegroundExec,
        buildForegroundExecResult,
        buildBackgroundTimeoutResult,
        readFinishedExecWorkingDirectory,
        readLiveExecWorkingDirectory,
    };

    const agentName = ctx.session?.agent || 'main';
    const nodeId = ctx.runtimeNodeId || 'master';
    const execEntry = await runtime.startPersistentExec({
        command,
        sessionId: ctx.sessionId,
        agentName,
        nodeId,
        cwd,
        sessionCwd: ctx.toolExecutionSnapshot?.cwd ?? ctx.session?.cwd,
    });

    const status = await runtime.waitForExecCompletion(execEntry.id, timeoutSeconds * 1000);
    if (status) {
        try {
            const nextCwd = await runtime.readFinishedExecWorkingDirectory(execEntry);
            const result = await runtime.buildForegroundExecResult(execEntry, status, resolvedTimeout.warning);
            if (ctx.deferSessionCwdSync && typeof nextCwd === 'string' && nextCwd.trim()) {
                return { output: result, __execBatchCwdSync: { nextCwd: nextCwd.trim() } };
            }
            const cwdNotice = await maybeSyncSessionCwdFromExec(ctx, execEntry, nextCwd);
            return appendCwdNotice(result, cwdNotice);
        } finally {
            await runtime.finalizeForegroundExec(execEntry.id);
        }
    }

    const nextCwd = await runtime.readLiveExecWorkingDirectory(execEntry);
    await runtime.markExecForBackgroundNotification(execEntry.id);
    const result = await runtime.buildBackgroundTimeoutResult(execEntry, timeoutSeconds, resolvedTimeout.warning);
    if (ctx.deferSessionCwdSync && typeof nextCwd === 'string' && nextCwd.trim()) {
        return { output: result, __execBatchCwdSync: { nextCwd: nextCwd.trim() } };
    }
    const cwdNotice = await maybeSyncSessionCwdFromExec(ctx, execEntry, nextCwd);
    return appendCwdNotice(result, cwdNotice);
}
