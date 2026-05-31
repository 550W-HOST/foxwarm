import {
    ToolArgs,
    ToolContext,
} from './helpers';
import * as sessionManager from '../sessionManager';
import { DEFAULT_EXEC_TIMEOUT_SECONDS, MAX_EXEC_TIMEOUT_SECONDS, MIN_EXEC_TIMEOUT_SECONDS } from '../../packages/shared/dist/persistentExec';
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

function resolveExecTimeoutSeconds(timeoutValue: unknown): number {
    if (timeoutValue === undefined || timeoutValue === null) {
        return DEFAULT_EXEC_TIMEOUT_SECONDS;
    }

    if (typeof timeoutValue !== 'number' || !Number.isFinite(timeoutValue)) {
        throw new Error(`timeout must be a number between ${MIN_EXEC_TIMEOUT_SECONDS} and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
    }

    if (timeoutValue < MIN_EXEC_TIMEOUT_SECONDS || timeoutValue > MAX_EXEC_TIMEOUT_SECONDS) {
        throw new Error(`timeout must be between ${MIN_EXEC_TIMEOUT_SECONDS} and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
    }

    return timeoutValue;
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

    const syncResult = await sessionManager.setSessionCwd(ctx.sessionId, normalizedNext);
    if (!syncResult.changed || !syncResult.current) {
        return null;
    }

    if (syncResult.previous) {
        return `Working directory changed: \`${syncResult.previous}\` → \`${syncResult.current}\` (session cwd updated).`;
    }

    return `Working directory changed to \`${syncResult.current}\` (session cwd updated).`;
}

export async function tool_exec(args: ToolArgs, ctx: ToolContext) {
    const { command, cwd, timeout } = args;
    const timeoutSeconds = resolveExecTimeoutSeconds(timeout);

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
            const result = await buildForegroundExecResult(execEntry, status);
            return cwdNotice ? `${cwdNotice}\n\n${result}` : result;
        } finally {
            await finalizeForegroundExec(execEntry.id);
        }
    }

    const cwdNotice = await maybeSyncSessionCwdFromExec(ctx, execEntry, await readLiveExecWorkingDirectory(execEntry));
    await markExecForBackgroundNotification(execEntry.id);
    const result = await buildBackgroundTimeoutResult(execEntry, timeoutSeconds);
    return cwdNotice ? `${cwdNotice}\n\n${result}` : result;
}
