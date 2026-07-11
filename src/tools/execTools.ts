import {
    ToolArgs,
    ToolContext,
} from './helpers';
import * as sessionManager from '../sessionManager';
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

async function maybeSyncSessionCwdFromExec(ctx: ToolContext, entry: { initialCwd?: string }, nextCwd: string | null | undefined): Promise<string | null> {
    if (!ctx.sessionId || typeof nextCwd !== 'string' || nextCwd.trim().length === 0) {
        return null;
    }

    const normalizedNext = nextCwd.trim();
    const normalizedInitial = typeof entry.initialCwd === 'string' ? entry.initialCwd.trim() : '';
    if (normalizedInitial && normalizedNext === normalizedInitial) {
        return null;
    }

    const syncResult = await sessionManager.setSessionCwd(ctx.sessionId, normalizedNext);
    if (!syncResult.changed || !syncResult.current) {
        return null;
    }

    const defaultNote = 'This cwd will be used as the default cwd for subsequent exec/read/edit/write/apply_patch tool calls.';
    if (syncResult.previous) {
        return `SESSION CWD CHANGED: \`${syncResult.previous}\` → \`${syncResult.current}\`. ${defaultNote}`;
    }

    return `SESSION CWD CHANGED: \`${syncResult.current}\`. ${defaultNote}`;
}

function appendCwdNotice(result: string, cwdNotice: string | null): string {
    return cwdNotice ? `${result}\n\n${cwdNotice}` : result;
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
        sessionCwd: ctx.session?.cwd,
    });

    const status = await waitForExecCompletion(execEntry.id, timeoutSeconds * 1000);
    if (status) {
        try {
            const cwdNotice = await maybeSyncSessionCwdFromExec(ctx, execEntry, await readFinishedExecWorkingDirectory(execEntry));
            const result = await buildForegroundExecResult(execEntry, status, resolvedTimeout.warning);
            return appendCwdNotice(result, cwdNotice);
        } finally {
            await finalizeForegroundExec(execEntry.id);
        }
    }

    const cwdNotice = await maybeSyncSessionCwdFromExec(ctx, execEntry, await readLiveExecWorkingDirectory(execEntry));
    await markExecForBackgroundNotification(execEntry.id);
    const result = await buildBackgroundTimeoutResult(execEntry, timeoutSeconds, resolvedTimeout.warning);
    return appendCwdNotice(result, cwdNotice);
}
