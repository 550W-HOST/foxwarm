import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as vector from './vector';
import * as sessionManager from './sessionManager';
import { getVectorSearchLineage } from './session/archiveStore';
import { estimateTokenCount } from './tokenCount';
import { WORKSPACE_DIR, getAgentDir, getAgentMemoryDir } from './config';
import { checkPathAccess, checkToolPermission } from './isolatedCheck';
import * as mcpClient from './mcpClient';
import { browserManager } from './browser';
import { logger } from './common';
import { DEFAULT_EXEC_TIMEOUT_SECONDS, MAX_EXEC_TIMEOUT_SECONDS, MIN_EXEC_TIMEOUT_SECONDS } from './execTimeout';
import { nodesManager } from './nodes/manager';
import {
    buildBackgroundTimeoutResult,
    buildForegroundExecResult,
    finalizeForegroundExec,
    markExecForBackgroundNotification,
    readFinishedExecWorkingDirectory,
    readLiveExecWorkingDirectory,
    startPersistentExec,
    waitForExecCompletion,
} from './execManager';
import { applyUpdatePatch, buildAddedFileContent, parseApplyPatchInput } from './applyPatch';
import { COMPACT_PLAN_TOOL_DEFINITION } from './session/compactPlan';
import {
    tool_create_child_session,
    tool_send_to_session,
    tool_end_turn,
    tool_submit_compact_plan,
    tool_send_to_channel,
    tool_send_file,
    tool_list_sessions,
    tool_list_agents,
    tool_list_skills,
    tool_load_skill,
    tool_get_session_messages,
    tool_get_archived_messages,
    tool_get_archived_blocks,
    tool_get_context_archive,
    tool_delete_session,
    tool_update_session_name,
    tool_set_todo,
    tool_set_session_child_model,
    tool_set_session_compact_threshold,
    tool_update_session_snapshot,
    tool_stop_session,
    tool_compact_session,
    tool_create_timer,
    tool_list_timers,
    tool_delete_timer,
    tool_create_agent,
    tool_create_session,
    tool_set_agent_inherit,
    tool_set_agent_isolated,
    tool_move_session,
} from './toolsSessionAgent';

// Tool context type
interface ToolContext {
    sessionId?: string;
    session?: any;
    broadcast?: (text: string, options?: any) => Promise<void>;
    queueSystemEvent?: (message: string, type?: 'background' | 'trigger' | 'onboot') => Promise<void>;
    runtimeNodeId?: string;
}

// Tool function type
type ToolArgs = Record<string, any>;
type UnifiedToolSource = 'builtin' | 'mcp' | 'node';

const WORKSPACE = WORKSPACE_DIR;
fs.ensureDirSync(getAgentDir('main'));

const OPTIONAL_NODE_DESCRIPTION = 'Optional. Empty = current node; avoid `current`.';

export const MODEL_HIDDEN_TOOL_NAMES = new Set([
    'browse_open',
    'browse_list',
    'browse_get',
    'browse_close',
    'browse_interact',
    'get_archived_messages',
    'get_archived_blocks',
    'set_session_child_model',
    'set_session_compact_threshold',
    'update_session_snapshot',
    'create_agent',
    'create_session',
    'set_agent_inherit',
    'set_agent_isolated',
    'move_session',
    'remote_node',
    'call_mcp',
    'search_mcp_tools',
]);

export const MASTER_ONLY_TOOL_NAMES = [
    'remote_node', 'list_nodes', 'node_tools',
    'search_vector', 'search_memory', 'get_memory_context',
    'read_memory', 'write_memory', 'edit_memory', 'delete_memory', 'apply_patch_memory',
    'copy_between_nodes',
    'create_child_session', 'send_to_session', 'end_turn', 'submit_compact_plan', 'send_to_channel', 'send_file',
    'list_sessions', 'list_agents', 'list_skills', 'load_skill',
    'get_session_messages', 'get_archived_messages', 'get_archived_blocks', 'get_context_archive', 'delete_session',
    'update_session_name', 'set_todo', 'set_session_child_model', 'update_session_snapshot', 'stop_session',
    'compact_session',
    'create_timer', 'list_timers', 'delete_timer',
    'mcp_config', 'call_mcp', 'search_mcp_tools', 'list_mcp_servers',
    'search_tools', 'call_tool',
    'change_current_node',
    'create_agent', 'create_session', 'set_agent_inherit', 'set_agent_isolated', 'move_session',
];

const MASTER_ONLY_TOOL_NAME_SET = new Set(MASTER_ONLY_TOOL_NAMES);

export function isToolDirectlyExposedToModel(toolName: string): boolean {
    return !MODEL_HIDDEN_TOOL_NAMES.has(toolName);
}

export function isMasterOnlyToolName(toolName: string): boolean {
    return MASTER_ONLY_TOOL_NAME_SET.has(toolName);
}

// Helper function to resolve file path for agent
function expandHomePath(filePath: string): string {
    if (filePath === '~') {
        return os.homedir();
    }
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
        return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
}

function resolveAgentPath(filePath: string, agentName: string = 'main', sessionCwd?: string): string {
    const expandedPath = expandHomePath(filePath);
    if (path.isAbsolute(expandedPath)) {
        return path.resolve(expandedPath);
    }

    const agentDir = getAgentDir(agentName);
    const baseDir = (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0)
        ? expandHomePath(sessionCwd.trim())
        : agentDir;

    return path.resolve(baseDir, expandedPath);
}


function shouldEnforceIsolatedMasterPathAccess(ctx: ToolContext | undefined): boolean {
    return sessionManager.isSessionEffectivelyIsolated(ctx?.session) && (ctx?.runtimeNodeId || 'master') === 'master';
}

function normalizeMemoryRelativePath(filePath: string): string {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        throw new Error('filePath is required');
    }

    let normalized = filePath.trim().replace(/^[\\/]+/, '');
    normalized = normalized.replace(/^memory[\\/]+/, '');
    if (!normalized || normalized === '.' || normalized === 'memory') {
        throw new Error('filePath must point to a file inside the current agent memory directory.');
    }
    return normalized;
}

function resolveAgentMemoryPath(filePath: string, agentName: string = 'main'): string {
    if (path.isAbsolute(filePath)) {
        throw new Error('Memory tools require a path relative to the current agent memory/ directory.');
    }

    const memoryDir = getAgentMemoryDir(agentName);
    const relativePath = normalizeMemoryRelativePath(filePath);
    const resolved = path.resolve(memoryDir, relativePath);

    if (!(resolved === memoryDir || resolved.startsWith(memoryDir + path.sep))) {
        throw new Error('Path traversal detected: cannot access files outside the current agent memory directory');
    }

    return resolved;
}

async function readResolvedPath(fullPath: string, displayPath: string, startLine?: number, endLine?: number) {
    const ext = path.extname(fullPath).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

    if (imageExts.includes(ext)) {
        const buffer = await fs.readFile(fullPath);
        const base64 = buffer.toString('base64');
        const mimeType = ext === '.png' ? 'image/png' :
                        ext === '.gif' ? 'image/gif' :
                        ext === '.webp' ? 'image/webp' :
                        ext === '.bmp' ? 'image/bmp' : 'image/jpeg';

        return {
            output: `[Image loaded: ${displayPath}]`,
            mimeType,
            sizeBytes: buffer.length,
            inlineData: { data: base64, mimeType }
        };
    }

    let content = await fs.readFile(fullPath, 'utf8');

    if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n');
        const start = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
        const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
        content = lines.slice(start, end).join('\n');
    }

    const tokens = estimateTokenCount(content);
    if (tokens > 10000) {
        const shortNotice = `[TOO LONG (~${tokens} tokens)]`;
        const fullNotice = `${shortNotice} TRUNCATED. Showing first 10000 chars only.`;
        return `${shortNotice}\n\n${content.slice(0, 10000)}\n\n${fullNotice}`;
    }

    return content;
}

async function writeResolvedPath(fullPath: string, content: string, overwrite: boolean, existsMessage: string) {
    const exists = await fs.pathExists(fullPath);
    if (exists && !overwrite) {
        throw new Error(existsMessage);
    }

    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content);
}

async function editResolvedPath(fullPath: string, oldText: string, newText: string) {
    const content = await fs.readFile(fullPath, 'utf8');

    if (typeof oldText !== 'string' || typeof newText !== 'string') {
        throw new Error('Edit tool requires oldText and newText. Use apply_patch for patch-style edits.');
    }

    const updatedContent = applyExactReplacement(content, oldText, newText, 'oldText');
    await fs.writeFile(fullPath, updatedContent);
}

async function deleteResolvedPath(fullPath: string, displayPath: string) {
    const stats = await fs.lstat(fullPath);
    if (stats.isDirectory()) {
        throw new Error(`Cannot delete directory: ${displayPath}`);
    }

    await fs.remove(fullPath);
}

function resolveExecCwd(cwdValue: unknown, ctx: ToolContext, agentName: string): string | undefined {
    if (typeof cwdValue !== 'string' || cwdValue.trim().length === 0) {
        return undefined;
    }

    const raw = cwdValue.trim();
    if (path.isAbsolute(raw)) {
        return raw;
    }

    const base = (typeof ctx.session?.cwd === 'string' && ctx.session.cwd.trim().length > 0)
        ? ctx.session.cwd.trim()
        : getAgentDir(agentName);
    return path.resolve(base, raw);
}

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

async function tool_read(args: ToolArgs, ctx: ToolContext) {
    const { filePath, startLine, endLine } = args;
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }
    return readResolvedPath(fullPath, filePath, startLine, endLine);
}

async function tool_write(args: ToolArgs, ctx: ToolContext) {
    const { filePath, content, overwrite } = args;
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }
    await writeResolvedPath(fullPath, content, overwrite === true, `File already exists: ${filePath}. Use overwrite=true to overwrite, or use edit tool to modify existing file.`);
    return 'File written successfully';
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyExactReplacement(content: string, searchText: string, replaceText: string, label: string): string {
    if (!content.includes(searchText)) {
        throw new Error(`Could not find ${label} in file. Make sure whitespace matches exactly.`);
    }

    const regex = new RegExp(escapeRegExp(searchText), 'g');
    const matches = content.match(regex);
    if (matches && matches.length > 1) {
        throw new Error(`Found ${matches.length} occurrences of ${label} in file. Edit tool only replaces once. Please make ${label} more specific to match exactly one location.`);
    }

    return content.replace(regex, replaceText);
}

async function tool_edit(args: ToolArgs, ctx: ToolContext) {
    const { filePath, oldText, newText } = args;
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }
    await editResolvedPath(fullPath, oldText, newText);
    return 'File edited successfully';
}

async function tool_read_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath, startLine, endLine } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    return readResolvedPath(fullPath, relativePath, startLine, endLine);
}

async function tool_write_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath, content } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    await writeResolvedPath(fullPath, content, false, `Memory file already exists: ${relativePath}. write_memory only creates new files; use edit_memory to modify an existing memory file.`);
    return `Memory file created: ${relativePath}`;
}

async function tool_edit_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath, oldText, newText } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    await editResolvedPath(fullPath, oldText, newText);
    return `Memory file edited: ${relativePath}`;
}

async function tool_delete_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    await deleteResolvedPath(fullPath, relativePath);
    return `Deleted memory file \`${relativePath}\``;
}

async function applyPatchOperations(input: string, resolveOperationPath: (filePath: string) => {
    fullPath: string;
    displayPath: string;
}): Promise<string> {
    const operations = parseApplyPatchInput(input);
    const summaries: string[] = [];

    for (const operation of operations) {
        const { fullPath, displayPath } = resolveOperationPath(operation.filePath);

        if (operation.action === 'update') {
            if (!await fs.pathExists(fullPath)) {
                throw new Error(`Cannot update missing file: ${displayPath}`);
            }
            const content = await fs.readFile(fullPath, 'utf8');
            const updatedContent = applyUpdatePatch(content, operation.lines, displayPath);
            await fs.writeFile(fullPath, updatedContent);
            summaries.push(`Updated ${displayPath}`);
            continue;
        }

        if (operation.action === 'add') {
            if (await fs.pathExists(fullPath)) {
                throw new Error(`Cannot add file that already exists: ${displayPath}`);
            }
            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, buildAddedFileContent(operation.lines));
            summaries.push(`Added ${displayPath}`);
            continue;
        }

        if (!await fs.pathExists(fullPath)) {
            throw new Error(`Cannot delete missing file: ${displayPath}`);
        }
        await fs.remove(fullPath);
        summaries.push(`Deleted ${displayPath}`);
    }

    return `Patch applied successfully.\n${summaries.map(line => `- ${line}`).join('\n')}`;
}

async function tool_apply_patch(args: ToolArgs, ctx: ToolContext) {
    const { input } = args;

    if (!input || typeof input !== 'string') {
        throw new Error('apply_patch requires input string.');
    }

    const agentName = ctx.session?.agent || 'main';
    return applyPatchOperations(input, (filePath) => {
        const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
        if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
            checkPathAccess(fullPath, agentName);
        }
        return {
            fullPath,
            displayPath: filePath,
        };
    });
}

async function tool_apply_patch_memory(args: ToolArgs, ctx: ToolContext) {
    const { input } = args;

    if (!input || typeof input !== 'string') {
        throw new Error('apply_patch_memory requires input string.');
    }

    const agentName = ctx.session?.agent || 'main';
    return applyPatchOperations(input, (filePath) => ({
        fullPath: resolveAgentMemoryPath(filePath, agentName),
        displayPath: normalizeMemoryRelativePath(filePath),
    }));
}

type ListFilesEntry = {
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modifiedAt: string;
};

async function collectFileEntries(baseDir: string, relativeDir: string, options: {
    recursive: boolean;
    includeHidden: boolean;
    limit: number;
}, bucket: ListFilesEntry[]): Promise<void> {
    if (bucket.length >= options.limit) {
        return;
    }

    const fullDir = path.join(baseDir, relativeDir);
    const entries = await fs.readdir(fullDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
        if (!options.includeHidden && entry.name.startsWith('.')) {
            continue;
        }
        if (bucket.length >= options.limit) {
            return;
        }

        const relPath = relativeDir ? path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name) : entry.name;
        const fullPath = path.join(fullDir, entry.name);
        const stats = await fs.stat(fullPath);
        bucket.push({
            path: relPath,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isDirectory() ? undefined : stats.size,
            modifiedAt: stats.mtime.toISOString(),
        });

        if (options.recursive && entry.isDirectory()) {
            await collectFileEntries(baseDir, path.join(relativeDir, entry.name), options, bucket);
        }
    }
}

async function tool_list_files(args: ToolArgs, ctx: ToolContext) {
    const { dirPath = '.', recursive = false, includeHidden = false, limit = 200 } = args;
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(dirPath, agentName, ctx.session?.cwd);

    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }

    const stats = await fs.stat(fullPath);
    if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${dirPath}`);
    }

    const entries: ListFilesEntry[] = [];
    await collectFileEntries(fullPath, '', {
        recursive: recursive === true,
        includeHidden: includeHidden === true,
        limit: Math.max(1, Math.min(Number(limit) || 200, 1000)),
    }, entries);

    const rootLabel = dirPath === '.' ? agentName : dirPath;
    if (entries.length === 0) {
        return `No files found under \`${rootLabel}\`.`;
    }

    return `Files under \`${rootLabel}\` (${entries.length}):\n\n` + entries.map(entry => {
        const sizeLabel = entry.type === 'file' ? ` (${entry.size} B)` : '/';
        return `- \`${entry.path}\`${sizeLabel} - ${entry.modifiedAt}`;
    }).join('\n');
}

async function tool_delete_file(args: ToolArgs, ctx: ToolContext) {
    const { filePath } = args;
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('filePath is required');
    }

    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);

    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }

    await deleteResolvedPath(fullPath, filePath);
    return `Deleted file \`${filePath}\``;
}

async function tool_copy_between_nodes(args: ToolArgs, ctx: ToolContext) {
    const { sourceNode, sourcePath, targetNode, targetPath, overwrite = false } = args;

    if (!ctx.sessionId) {
        throw new Error('copy_between_nodes requires an active session context.');
    }

    if (!sourceNode || !targetNode || !sourcePath || !targetPath) {
        throw new Error('copy_between_nodes requires sourceNode, sourcePath, targetNode, and targetPath.');
    }

    const file = await nodesManager.readFileFromNode(String(sourceNode), String(sourcePath), ctx.sessionId);
    const result = await nodesManager.writeFileToNode(String(targetNode), String(targetPath), file.dataBase64, overwrite === true, ctx.sessionId);

    return [
        `Copied \`${sourcePath}\` from node \`${sourceNode}\` to \`${targetPath}\` on node \`${targetNode}\`.`,
        `Size: ${file.sizeBytes} B`,
        `SHA256: ${result.sha256}`,
        `Overwrote existing file: ${result.overwritten ? 'yes' : 'no'}`,
    ].join('\n');
}

async function tool_exec(args: ToolArgs, ctx: ToolContext) {
    const { command, cwd, timeout } = args;
    const timeoutSeconds = resolveExecTimeoutSeconds(timeout);

    // Mark that we're about to exec, then save session
    if (ctx && ctx.sessionId) {
        await sessionManager.saveSession(ctx.sessionId);
    }

    const agentName = ctx.session?.agent || 'main';
    const nodeId = ctx.runtimeNodeId || 'master';
    const execCwd = resolveExecCwd(cwd, ctx, agentName) || ctx.session?.cwd || undefined;
    const execEntry = await startPersistentExec({
        command,
        sessionId: ctx.sessionId,
        agentName,
        nodeId,
        cwd: execCwd,
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

export async function resolveMemorySearchOptions(
    request: {
        scope?: 'all' | 'current-session' | 'current-agent';
        targetSessionId?: string;
        targetAgentName?: string;
    },
    ctx?: ToolContext,
): Promise<{ searchOptions: { sessionIds?: string[]; agent?: string; lineageSessions?: Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }> }; effectiveScope: 'current-session' | 'current-agent' }> {
    if (!ctx?.sessionId) {
        throw new Error('search_vector requires an active session context.');
    }

    const session = await sessionManager.getSession(ctx.sessionId);
    const agentName = session.agent || 'main';
    const effectiveIsolated = sessionManager.isSessionEffectivelyIsolated(session);
    const subconsciousPrimarySessionId = sessionManager.getSubconsciousPrimarySessionId(session);

    async function buildSessionScopedSearchOptions(targetSessionId: string, extraSessionIds: string[] = []) {
        const lineage = await getVectorSearchLineage(targetSessionId);
        if (lineage.length > 0) {
            return {
                lineageSessions: lineage.map(entry => ({
                    sessionId: entry.sessionId,
                    maxMessageSeq: entry.maxMessageSeq,
                    maxBlockId: entry.maxBlockId,
                })),
            };
        }

        return {
            sessionIds: [targetSessionId, ...extraSessionIds],
        };
    }

    if (subconsciousPrimarySessionId) {
        if (request.targetAgentName && request.targetAgentName !== agentName) {
            throw new Error('Subconscious side session can only search itself or its primary session.');
        }

        const allowedSessionIds = [subconsciousPrimarySessionId, session.id, ...(session.aliases || [])];
        if (request.targetSessionId) {
            if (!allowedSessionIds.includes(request.targetSessionId)) {
                throw new Error('Subconscious side session can only search itself or its primary session.');
            }

            if (request.targetSessionId === session.id || (session.aliases || []).includes(request.targetSessionId)) {
                return {
                    searchOptions: await buildSessionScopedSearchOptions(session.id, session.aliases || []),
                    effectiveScope: 'current-session',
                };
            }
        }

        return {
            searchOptions: await buildSessionScopedSearchOptions(subconsciousPrimarySessionId),
            effectiveScope: 'current-session',
        };
    }

    if (effectiveIsolated) {
        if (request.targetAgentName && request.targetAgentName !== agentName) {
            throw new Error('Isolated session can only search the current session.');
        }
        if (request.targetSessionId && request.targetSessionId !== session.id && !(session.aliases || []).includes(request.targetSessionId)) {
            throw new Error('Isolated session can only search the current session.');
        }
        return {
            searchOptions: await buildSessionScopedSearchOptions(session.id, session.aliases || []),
            effectiveScope: 'current-session',
        };
    }

    if (request.targetAgentName && request.targetAgentName !== agentName) {
        throw new Error('search_vector cannot access memories outside the current agent.');
    }

    if (request.targetSessionId) {
        const targetSession = await sessionManager.getExistingSession(request.targetSessionId);
        if (!targetSession) {
            throw new Error(`Session \`${request.targetSessionId}\` not found.`);
        }
        if ((targetSession.agent || 'main') !== agentName) {
            throw new Error('search_vector cannot access memories outside the current agent.');
        }
        return {
            searchOptions: await buildSessionScopedSearchOptions(targetSession.id, targetSession.aliases || []),
            effectiveScope: 'current-session',
        };
    }

    if (request.scope === 'current-session') {
        return {
            searchOptions: await buildSessionScopedSearchOptions(session.id, session.aliases || []),
            effectiveScope: 'current-session',
        };
    }

    return {
        searchOptions: { agent: agentName },
        effectiveScope: 'current-agent',
    };
}

export function formatMemorySearchResults(results: any): string {
    if (!results || !Array.isArray(results) || results.length === 0) return 'No relevant memories found.';

    const now = Date.now();

    function formatAgeLabel(ts: number | null): string {
        if (!ts || !Number.isFinite(ts)) return 'age: unknown';
        const deltaMs = Math.max(0, now - ts);
        const minutes = Math.floor(deltaMs / 60000);
        if (minutes < 1) return 'RECENT · just now';
        if (minutes < 60) return `RECENT · ${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 48) return `RECENT · ${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 14) return `RECENT · ${days}d ago`;
        if (days < 60) return `AGING · ${days}d ago`;
        return `OLD · ${days}d ago`;
    }

    function buildPreview(text: string, maxChars: number = 420): string {
        const normalized = String(text || '').trim().replace(/\n{3,}/g, '\n\n');
        if (normalized.length <= maxChars) return normalized;

        const clipped = normalized.slice(0, maxChars);
        const lastBoundary = Math.max(
            clipped.lastIndexOf('\n'),
            clipped.lastIndexOf('. '),
            clipped.lastIndexOf('。'),
            clipped.lastIndexOf('! '),
            clipped.lastIndexOf('? '),
        );

        if (lastBoundary >= Math.floor(maxChars * 0.55)) {
            return `${clipped.slice(0, lastBoundary).trim()}…`;
        }

        return `${clipped.trim()}…`;
    }

    return results.map(r => {
        const tsSource = r.end_timestamp ?? r.start_timestamp ?? r.timestamp;
        const ts = tsSource != null && !isNaN(Number(tsSource)) ? Number(tsSource) : null;
        const date = ts ? new Date(ts) : null;
        const dateStr = (date && !isNaN(date.getTime())) ? date.toISOString() : 'unknown';
        const idStr = (r.id && typeof r.id === 'string') ? `${r.id.substring(0, 8)}...` : 'N/A';
        const seqLabel = r.start_seq != null && r.end_seq != null && Number(r.start_seq) !== Number(r.end_seq)
            ? `${r.start_seq}-${r.end_seq}`
            : `${r.start_seq ?? r.seq}`;
        const rawSeqLabel = r.raw_start_seq != null && r.raw_end_seq != null && Number(r.raw_start_seq) !== Number(r.raw_end_seq)
            ? `${r.raw_start_seq}-${r.raw_end_seq}`
            : `${r.raw_start_seq ?? r.start_seq ?? r.seq}`;
        const messageLabel = r.message_count > 1
            ? `[messages: ${r.message_count}]`
            : '';
        const chunkLabel = r.chunk_count > 1
            ? `[chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]`
            : '';
        const kindLabel = r.kind === 'block'
            ? `[kind: block] [B#${r.block_id ?? '?'} L${r.block_level ?? '?'}] [raw: ${rawSeqLabel}]`
            : '';
        const ageLabel = `[${formatAgeLabel(ts)}]`;
        const preview = buildPreview(r.text || r.chunk_text || '');

        return [
            `[${dateStr}] [session: ${r.session_id}] [seq: ${seqLabel}]`,
            ageLabel,
            kindLabel,
            messageLabel,
            chunkLabel,
            `[ID: ${idStr}]`,
        ].filter(Boolean).join(' ') + `\n${preview}`;
    }).join('\n\n---\n\n');
}

async function tool_search_vector({
    query,
    limit = 5,
    scope = 'all',
    sessionId,
    agentName,
    includeRegex,
    excludeRegex,
    preferBlocks,
}: {
    query: string;
    limit?: number;
    scope?: 'all' | 'current-session' | 'current-agent';
    sessionId?: string;
    agentName?: string;
    includeRegex?: string;
    excludeRegex?: string;
    preferBlocks?: boolean;
}, ctx?: ToolContext) {
    const { searchOptions } = await resolveMemorySearchOptions({
        scope,
        targetSessionId: sessionId,
        targetAgentName: agentName,
    }, ctx);

    const results = await vector.search(query, limit, false, {
        ...searchOptions,
        includeRegex,
        excludeRegex,
        preferBlocks,
    });
    return formatMemorySearchResults(results);
}

async function tool_get_memory_context({ timestamp, limit = 10 }: { timestamp: number; limit?: number }) {
    const results = await vector.getContextAround(timestamp, limit);
    if (!results || results.length === 0) return 'No context found around this time.';

    return results.map(r => {
        const ts = r.timestamp != null && !isNaN(Number(r.timestamp)) ? Number(r.timestamp) : null;
        const date = ts ? new Date(ts) : null;
        const dateStr = (date && !isNaN(date.getTime())) ? date.toISOString() : 'unknown';
        const idStr = (r.id && typeof r.id === 'string') ? `${r.id.substring(0, 8)}...` : 'N/A';
        const seqLabel = r.start_seq != null && r.end_seq != null && Number(r.start_seq) !== Number(r.end_seq)
            ? `${r.start_seq}-${r.end_seq}`
            : `${r.start_seq ?? r.seq}`;
        const messageLabel = r.message_count > 1
            ? `[messages: ${r.message_count}]`
            : '';
        const chunkLabel = r.chunk_count > 1
            ? `[chunk ${Number(r.chunk_index) + 1}/${r.chunk_count}]`
            : '';

        return [
            `[${dateStr}] [session: ${r.session_id}] [seq: ${seqLabel}]`,
            messageLabel,
            chunkLabel,
            `[ID: ${idStr}]`,
        ].filter(Boolean).join(' ') + `\n${r.text}`;
    }).join('\n\n---\n\n');
}

async function tool_browse_open(args: ToolArgs) {
    const { url } = args;
    const result = await browserManager.openTab(url);
    return `Tab opened: ${result.id}\nTitle: ${result.title}\nURL: ${url}`;
}

async function tool_browse_list(args: ToolArgs) {
    const tabs = browserManager.listTabs();
    if (tabs.length === 0) {
        return 'No tabs open';
    }
    return tabs.map(t => `${t.id}: ${t.title}\n  URL: ${t.url}`).join('\n\n');
}

async function tool_browse_get(args: ToolArgs) {
    const { tabId, screenshot } = args;
    
    if (screenshot) {
        const base64 = await browserManager.getTabScreenshot(tabId);
        
        // Check if screenshot is a file path (string starting with /)
        if (typeof screenshot === 'string' && screenshot.startsWith('/')) {
            // Save to file
            const buffer = Buffer.from(base64, 'base64');
            await fs.writeFile(screenshot, buffer);
            return `Screenshot saved to: ${screenshot}`;
        } else {
            return {
                output: `[Screenshot of ${tabId}]`,
                mimeType: 'image/png',
                sizeBytes: Buffer.byteLength(base64, 'base64'),
                inlineData: { data: base64, mimeType: 'image/png' }
            };
        }
    } else {
        const { text } = await browserManager.getTabContent(tabId);
        return text;
    }
}

async function tool_browse_close(args: ToolArgs) {
    const { tabId } = args;
    await browserManager.closeTab(tabId);
    return `Tab ${tabId} closed`;
}

async function tool_browse_interact(args: ToolArgs) {
    const { tabId, action, params } = args;
    const result = await browserManager.interact(tabId, action, params || {});
    return result;
}

function buildUnifiedToolId(source: UnifiedToolSource, name: string, options: { server?: string; nodeId?: string } = {}): string {
    if (source === 'builtin') {
        return `builtin:${name}`;
    }

    if (source === 'mcp') {
        if (!options.server) {
            throw new Error('MCP tool IDs require server.');
        }
        return `mcp:${options.server}/${name}`;
    }

    if (!options.nodeId) {
        throw new Error('Node tool IDs require nodeId.');
    }

    return `node:${options.nodeId}/${name}`;
}

function parseUnifiedToolId(toolId: string): { source: UnifiedToolSource; name: string; server?: string; nodeId?: string } {
    if (typeof toolId !== 'string' || toolId.trim().length === 0) {
        throw new Error('toolId is required');
    }

    if (toolId.startsWith('builtin:')) {
        const name = toolId.slice('builtin:'.length).trim();
        if (!name) throw new Error(`Invalid builtin toolId: ${toolId}`);
        return { source: 'builtin', name };
    }

    if (toolId.startsWith('mcp:')) {
        const remainder = toolId.slice('mcp:'.length);
        const separator = remainder.indexOf('/');
        if (separator <= 0 || separator === remainder.length - 1) {
            throw new Error(`Invalid MCP toolId: ${toolId}`);
        }
        return {
            source: 'mcp',
            server: remainder.slice(0, separator),
            name: remainder.slice(separator + 1),
        };
    }

    if (toolId.startsWith('node:')) {
        const remainder = toolId.slice('node:'.length);
        const separator = remainder.indexOf('/');
        if (separator <= 0 || separator === remainder.length - 1) {
            throw new Error(`Invalid node toolId: ${toolId}`);
        }
        return {
            source: 'node',
            nodeId: remainder.slice(0, separator),
            name: remainder.slice(separator + 1),
        };
    }

    throw new Error(`Unsupported toolId source: ${toolId}`);
}

function normalizeUnifiedToolSources(rawSources: unknown): UnifiedToolSource[] {
    const allowed: UnifiedToolSource[] = ['builtin', 'mcp', 'node'];
    if (rawSources === undefined || rawSources === null) {
        return allowed;
    }

    const items = Array.isArray(rawSources) ? rawSources : [rawSources];
    const normalized = items.map(item => String(item).trim()).filter(Boolean);
    if (normalized.length === 0) {
        return allowed;
    }

    const invalid = normalized.filter((item): item is string => !allowed.includes(item as UnifiedToolSource));
    if (invalid.length > 0) {
        throw new Error(`Invalid sources: ${invalid.join(', ')}. Supported sources: ${allowed.join(', ')}`);
    }

    return Array.from(new Set(normalized as UnifiedToolSource[]));
}

function normalizeRequestedNodeForToolCall(nodeParam: unknown, currentNode: string): string {
    if (nodeParam === undefined || nodeParam === null) {
        return currentNode;
    }

    if (typeof nodeParam !== 'string') {
        return String(nodeParam) || currentNode;
    }

    const trimmed = nodeParam.trim();
    if (!trimmed || trimmed.toLowerCase() === 'current') {
        return currentNode;
    }

    return trimmed;
}

function matchesUnifiedToolQuery(query: string, fields: Array<string | undefined>): boolean {
    return scoreUnifiedToolQuery(query, fields) >= 0;
}

function normalizeUnifiedToolQueryTerms(query: string): string[] {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery ? Array.from(new Set(normalizedQuery.split(/\s+/).filter(Boolean))) : [];
}

function scoreUnifiedToolQuery(query: string, fields: Array<string | undefined>): number {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return 0;
    }

    const terms = normalizeUnifiedToolQueryTerms(query);
    const normalizedFields = fields.map(field => String(field || '').toLowerCase());
    const primaryField = normalizedFields[0] || '';
    let score = 0;
    let matchedTerms = 0;

    if (primaryField === normalizedQuery) {
        score += 400;
    } else if (primaryField.startsWith(normalizedQuery)) {
        score += 260;
    } else if (primaryField.includes(normalizedQuery)) {
        score += 180;
    } else if (normalizedFields.some(field => field.includes(normalizedQuery))) {
        score += 120;
    }

    for (const term of terms) {
        let matched = false;
        for (const field of normalizedFields) {
            if (!field.includes(term)) {
                continue;
            }
            matched = true;
            score += field === primaryField ? 40 : 24;
            if (field.startsWith(term)) {
                score += field === primaryField ? 16 : 8;
            }
            break;
        }

        if (matched) {
            matchedTerms += 1;
        }
    }

    if (matchedTerms === 0) {
        return -1;
    }

    if (matchedTerms === terms.length && terms.length > 1) {
        score += 90;
    }

    score += matchedTerms * 12;
    return score;
}

async function resolveDefaultNodeSearchTarget(ctx?: ToolContext): Promise<string> {
    if (typeof ctx?.session?.currentNode === 'string' && ctx.session.currentNode.trim().length > 0) {
        return ctx.session.currentNode.trim();
    }

    if (ctx?.sessionId) {
        const currentNode = await nodesManager.getCurrentNode(ctx.sessionId);
        if (typeof currentNode === 'string' && currentNode.trim().length > 0) {
            return currentNode.trim();
        }
    }

    return 'master';
}

async function executeBuiltinToolViaUnifiedCall(toolName: string, rawArgs: ToolArgs, ctx: ToolContext): Promise<any> {
    const toolDefinition = definitions.find(def => def.name === toolName);
    if (!toolDefinition) {
        throw new Error(`Unknown builtin tool: ${toolName}`);
    }

    const supportsExplicitNode = Object.prototype.hasOwnProperty.call(toolDefinition.parameters?.properties || {}, 'node');
    if (!supportsExplicitNode && rawArgs && Object.prototype.hasOwnProperty.call(rawArgs, 'node')) {
        throw new Error(`Builtin tool \`${toolName}\` does not support node selection. Use call_tool with source=\`node\` for remote-node execution.`);
    }

    const sessionId = ctx.sessionId || 'main';
    const currentNode = ctx.sessionId
        ? (await nodesManager.getCurrentNode(sessionId) || 'master')
        : (ctx.session?.currentNode || 'master');
    const targetNode = supportsExplicitNode
        ? normalizeRequestedNodeForToolCall(rawArgs?.node, currentNode)
        : currentNode;
    const toolArgs = { ...(rawArgs || {}) };
    delete toolArgs.node;

    const executionNode = isMasterOnlyToolName(toolName) ? 'master' : targetNode;
    const permissionNode = toolName === 'send_file' ? targetNode : executionNode;

    if (ctx.sessionId) {
        await checkToolPermission(toolName, sessionId, permissionNode, toolArgs);
    }

    if (executionNode !== 'master') {
        return await nodesManager.executeTool(executionNode, toolName, toolArgs, sessionId);
    }

    return await nodesManager.executeToolLocally(toolName, toolArgs, sessionId);
}

async function collectBuiltinUnifiedSearchResults(query: string, includeSchema: boolean) {
    return definitions
        .map(def => ({ def, score: scoreUnifiedToolQuery(query, [def.name, def.description]) }))
        .filter(entry => entry.score >= 0)
        .map(def => ({
            _score: def.score,
            source: 'builtin' as const,
            toolId: buildUnifiedToolId('builtin', def.def.name),
            name: def.def.name,
            description: def.def.description,
            ...(includeSchema ? { inputSchema: def.def.parameters } : {}),
            directExposed: isToolDirectlyExposedToModel(def.def.name),
            hidden: !isToolDirectlyExposedToModel(def.def.name),
        }));
}

async function collectMcpUnifiedSearchResults(query: string, includeSchema: boolean, serverFilter: string | undefined, ctx?: ToolContext) {
    if (ctx?.sessionId) {
        await checkToolPermission('search_mcp_tools', ctx.sessionId, 'master', { server: serverFilter, query });
    }

    const servers = serverFilter
        ? [serverFilter]
        : (await mcpClient.listServers())
            .filter(server => server.enabled)
            .map(server => server.name);

    const results: Array<Record<string, any>> = [];
    for (const serverName of servers) {
        const tools = await mcpClient.listTools(serverName);
        const items = Array.isArray((tools as any)?.tools)
            ? (tools as any).tools
            : (Array.isArray(tools) ? tools as any[] : []);

        for (const item of items) {
            const score = scoreUnifiedToolQuery(query, [item?.name, item?.description, serverName]);
            if (score < 0) {
                continue;
            }

            results.push({
                _score: score,
                source: 'mcp',
                toolId: buildUnifiedToolId('mcp', String(item?.name || ''), { server: serverName }),
                name: item?.name || 'unknown',
                description: item?.description || '',
                server: serverName,
                ...(includeSchema ? { inputSchema: item?.inputSchema || null } : {}),
                ...(includeSchema && item?.annotations ? { annotations: item.annotations } : {}),
            });
        }
    }

    return results;
}

async function collectNodeUnifiedSearchResults(query: string, includeSchema: boolean, nodeFilter: string | undefined, ctx?: ToolContext) {
    const effectiveNodeId = nodeFilter || await resolveDefaultNodeSearchTarget(ctx);
    const nodeListing = await tool_remote_node({ action: 'list', nodeId: effectiveNodeId }, (ctx || ({} as ToolContext))) as any;
    const nodes = Array.isArray(nodeListing?.nodes) ? nodeListing.nodes : [];

    const results: Array<Record<string, any>> = [];
    for (const node of nodes) {
        for (const item of Array.isArray(node?.tools) ? node.tools : []) {
            const score = scoreUnifiedToolQuery(query, [item?.name, item?.description, node?.id, node?.type]);
            if (score < 0) {
                continue;
            }

            results.push({
                _score: score,
                source: 'node',
                toolId: buildUnifiedToolId('node', String(item?.name || ''), { nodeId: String(node?.id || '') }),
                name: item?.name || 'unknown',
                description: item?.description || '',
                nodeId: node?.id || '',
                nodeType: node?.type || '',
                ...(includeSchema ? { inputSchema: item?.parameters || null } : {}),
            });
        }
    }

    return results;
}

async function tool_search_tools(args: ToolArgs, ctx?: ToolContext) {
    const query = typeof args?.query === 'string' ? args.query : '';
    const sources = normalizeUnifiedToolSources(args?.sources);
    const server = typeof args?.server === 'string' && args.server.trim() ? args.server.trim() : undefined;
    const nodeId = typeof args?.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined;
    const includeSchema = args?.includeSchema !== false;
    const limit = Math.max(1, Math.min(Number(args?.limit) || 20, 200));
    const warnings: string[] = [];

    const collected: Array<Record<string, any>> = [];

    if (sources.includes('builtin')) {
        collected.push(...await collectBuiltinUnifiedSearchResults(query, includeSchema));
    }

    if (sources.includes('mcp')) {
        try {
            collected.push(...await collectMcpUnifiedSearchResults(query, includeSchema, server, ctx));
        } catch (e: any) {
            warnings.push(e?.message || String(e));
        }
    }

    if (sources.includes('node')) {
        try {
            collected.push(...await collectNodeUnifiedSearchResults(query, includeSchema, nodeId, ctx));
        } catch (e: any) {
            warnings.push(e?.message || String(e));
        }
    }

    collected.sort((a, b) => {
        const scoreCompare = Number(b._score || 0) - Number(a._score || 0);
        if (scoreCompare !== 0) return scoreCompare;
        const sourceCompare = String(a.source).localeCompare(String(b.source));
        if (sourceCompare !== 0) return sourceCompare;
        const scopeA = String(a.server || a.nodeId || '');
        const scopeB = String(b.server || b.nodeId || '');
        const scopeCompare = scopeA.localeCompare(scopeB);
        if (scopeCompare !== 0) return scopeCompare;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return {
        count: Math.min(collected.length, limit),
        totalMatched: collected.length,
        tools: collected.slice(0, limit).map(({ _score, ...tool }) => tool),
        ...(warnings.length > 0 ? { warnings } : {}),
    };
}

async function tool_call_tool(args: ToolArgs, ctx: ToolContext) {
    const explicitSource = typeof args?.source === 'string' ? args.source.trim() : undefined;
    const ref = args?.toolId
        ? parseUnifiedToolId(String(args.toolId))
        : {
            source: explicitSource as UnifiedToolSource,
            name: typeof args?.name === 'string' ? args.name : '',
            server: typeof args?.server === 'string' ? args.server : undefined,
            nodeId: typeof args?.nodeId === 'string' ? args.nodeId : undefined,
        };

    if (!ref?.source || !['builtin', 'mcp', 'node'].includes(ref.source)) {
        throw new Error('call_tool requires either toolId or a valid source (builtin, mcp, node).');
    }
    if (!ref.name) {
        throw new Error('call_tool requires a tool name.');
    }

    if (!Object.prototype.hasOwnProperty.call(args || {}, 'args')) {
        throw new Error('call_tool requires args (wrapped target tool arguments object).');
    }

    if (!args?.args || typeof args.args !== 'object' || Array.isArray(args.args)) {
        throw new Error('call_tool args must be an object containing the target tool arguments.');
    }

    const toolArgs = args.args;

    if (ref.source === 'builtin') {
        return await executeBuiltinToolViaUnifiedCall(ref.name, toolArgs, ctx);
    }

    if (ref.source === 'mcp') {
        if (!ctx?.sessionId) {
            throw new Error('call_tool for MCP requires session context.');
        }
        await checkToolPermission('call_mcp', ctx.sessionId, 'master', {
            server: ref.server,
            tool: ref.name,
            args: toolArgs,
        });
        return await mcpClient.callTool(ref.server, ref.name, toolArgs);
    }

    if (!ref.nodeId) {
        throw new Error('call_tool for node source requires nodeId.');
    }

    return await tool_remote_node({
        action: 'call',
        nodeId: ref.nodeId,
        tool: ref.name,
        args: toolArgs,
    }, ctx);
}

async function tool_remote_node(args: ToolArgs, ctx: ToolContext) {
    const { action, nodeId, tool, args: toolArgs } = args;
    
    // Get session for isolated check
    const session = ctx.sessionId ? await sessionManager.getExistingSession(ctx.sessionId) : undefined;
    
    // Isolated sessions can only call tools on their bound node
    const isolatedAllowedRemoteNodes = sessionManager.isSessionEffectivelyIsolated(session)
        ? Array.from(new Set([
            sessionManager.getAgentIsolationNode(session?.agent || 'main') || session?.currentNode || 'master',
            session?.currentNode,
        ].filter((value): value is string => typeof value === 'string' && value.length > 0)))
        : [];

    if (sessionManager.isSessionEffectivelyIsolated(session) && action === 'call') {
        if (!isolatedAllowedRemoteNodes.includes(String(nodeId || ''))) {
            throw new Error(`Isolated session can only call tools on its bound/current node (${isolatedAllowedRemoteNodes.join(', ')}).`);
        }
    }
    
    if (action === 'list') {
        // List visible nodes and their tools, with optional node filter
        const nodes = nodesManager.listNodesWithTools();
        const visibleNodes = sessionManager.isSessionEffectivelyIsolated(session)
            ? nodes.filter((n: any) => isolatedAllowedRemoteNodes.includes(n.id))
            : nodes;
        const filteredNodes = typeof nodeId === 'string' && nodeId.trim().length > 0
            ? visibleNodes.filter((n: any) => n.id === nodeId)
            : visibleNodes;
        return {
            nodes: filteredNodes.map((n: any) => ({
                id: n.id,
                type: n.type,
                tools: n.tools.map((t: any) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters
                }))
            }))
        };
    }
    
    if (action === 'call') {
        // Call a specific tool on a node
        if (!nodeId || !tool) {
            throw new Error('nodeId and tool are required for call action');
        }
        
        const result = await nodesManager.executeNodeTool(
            nodeId,
            tool,
            toolArgs || {},
            ctx.sessionId
        );
        
        return result;
    }
    
    throw new Error(`Unknown action: ${action}`);
}

async function tool_mcp_config(args: ToolArgs) {
    const { name, url, command, args: commandArgs, env, cwd, stderr, token, headers, description, enable, transport, type } = args;
    const resolvedTransport = transport || type || 'auto';
    if (!name) {
        throw new Error('mcp_config requires name');
    }
    if (resolvedTransport === 'stdio') {
        if (!command) {
            throw new Error('mcp_config with stdio transport requires command');
        }
    } else if (!url) {
        throw new Error('mcp_config requires url for streamable-http, sse, or auto transport');
    }
    await mcpClient.upsertServer(name, { url, command, args: commandArgs, env, cwd, stderr, token, headers, description, enable, transport, type });
    return `MCP server \"${name}\" saved${enable === false ? ' (disabled)' : ''}.`;
}

async function tool_call_mcp(args: ToolArgs) {
    let { server, tool, args: toolArgs } = args;
    if (!tool) {
        throw new Error('call_mcp requires tool');
    }

    if (!server && typeof tool === 'string' && tool.includes('/')) {
        const [serverName, ...rest] = tool.split('/');
        if (serverName && rest.length) {
            server = serverName;
            tool = rest.join('/');
        }
    }

    const result = await mcpClient.callTool(server, tool, toolArgs || {});
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    const tokens = estimateTokenCount(text);

    if (tokens > 10000) {
        const tempDir = path.join(WORKSPACE, '.temp');
        await fs.ensureDir(tempDir);
        const logFileName = `mcp_${Date.now()}.log`;
        const logPath = path.join(tempDir, logFileName);
        await fs.writeFile(logPath, text);
        return `[OUTPUT TOO LONG (~${tokens} tokens)]. Full output saved to: ${logPath}`;
    }

    return text;
}

async function tool_search_mcp_tools(args: ToolArgs) {
    const { server, query } = args;
    const tools = await mcpClient.listTools(server);
    const list = Array.isArray(tools?.tools) ? tools.tools : tools;
    const items = Array.isArray(list) ? list : [];

    if (!items.length) {
        return 'No MCP tools available.';
    }

    const normalizedQuery = (query || '').toLowerCase().trim();
    const filtered = normalizedQuery
        ? items.filter((t: any) => {
            const name = String(t?.name || '').toLowerCase();
            const desc = String(t?.description || '').toLowerCase();
            return name.includes(normalizedQuery) || desc.includes(normalizedQuery);
        })
        : items;

    const limited = filtered.slice(0, 50).map((t: any) => {
        const name = t?.name || 'unknown';
        const fullName = server ? `${server}/${name}` : name;
        const desc = t?.description ? ` - ${t.description}` : '';
        return `${fullName}${desc}`;
    });

    if (!limited.length) {
        return 'No matching MCP tools.';
    }

    return `MCP tools (${limited.length}${filtered.length > limited.length ? ` of ${filtered.length}` : ''}):\n` + limited.join('\n');
}

async function tool_list_mcp_servers(_args: ToolArgs) {
    const servers = await mcpClient.listServers();

    if (!servers.length) {
        return {
            count: 0,
            servers: [] as mcpClient.McpServerSummary[],
            message: 'No MCP servers configured.',
        };
    }

    return {
        count: servers.length,
        servers,
    };
}

export const read = tool_read;
export const write = tool_write;
export const edit = tool_edit;
export const read_memory = tool_read_memory;
export const write_memory = tool_write_memory;
export const edit_memory = tool_edit_memory;
export const delete_memory = tool_delete_memory;
export const apply_patch_memory = tool_apply_patch_memory;
export const apply_patch = tool_apply_patch;
export const list_files = tool_list_files;
export const delete_file = tool_delete_file;
export const copy_between_nodes = tool_copy_between_nodes;
export const exec = tool_exec;
export const search_vector = tool_search_vector;
export const search_memory = tool_search_vector;
export const get_memory_context = tool_get_memory_context;
export const create_child_session = tool_create_child_session;
export const create_agent = tool_create_agent;
export const create_session = tool_create_session;
export const set_agent_inherit = tool_set_agent_inherit;
export const set_agent_isolated = tool_set_agent_isolated;
export const move_session = tool_move_session;
export const send_to_session = tool_send_to_session;
export const end_turn = tool_end_turn;
export const submit_compact_plan = tool_submit_compact_plan;
export const send_to_channel = tool_send_to_channel;
export const send_file = tool_send_file;
export const list_sessions = tool_list_sessions;
export const list_agents = tool_list_agents;
export const list_skills = tool_list_skills;
export const load_skill = tool_load_skill;
export const get_session_messages = tool_get_session_messages;
export const get_archived_messages = tool_get_archived_messages;
export const get_archived_blocks = tool_get_archived_blocks;
export const get_context_archive = tool_get_context_archive;
export const delete_session = tool_delete_session;
export const update_session_name = tool_update_session_name;
export const set_todo = tool_set_todo;
export const set_session_child_model = tool_set_session_child_model;
export const set_session_compact_threshold = tool_set_session_compact_threshold;
export const update_session_snapshot = tool_update_session_snapshot;
export const stop_session = tool_stop_session;
export const compact_session = tool_compact_session;
export const create_timer = tool_create_timer;
export const list_timers = tool_list_timers;
export const delete_timer = tool_delete_timer;
export const browse_open = tool_browse_open;
export const browse_list = tool_browse_list;
export const browse_get = tool_browse_get;
export const browse_close = tool_browse_close;
export const browse_interact = tool_browse_interact;
export const remote_node = tool_remote_node;
export const node_tools = tool_remote_node;
export const mcp_config = tool_mcp_config;
export const call_mcp = tool_call_mcp;
export const search_mcp_tools = tool_search_mcp_tools;
export const list_mcp_servers = tool_list_mcp_servers;
export const search_tools = tool_search_tools;
export const call_tool = tool_call_tool;

// New tools for nodes
export const list_nodes = async (args: ToolArgs) => {
  const nodes = nodesManager.listNodes();
  
  if (nodes.length === 0) {
    return 'No nodes registered.';
  }
  
  let result = `Found ${nodes.length} node(s):\n\n`;
  for (const node of nodes) {
    const isMaster = node.id === 'master';
    const label = isMaster ? ' (local)' : ' (remote)';
    result += `- \`${node.id}\`${label} - Last activity: ${new Date(node.lastActivity).toISOString()}\n`;
  }
  
  return result;
};

export const change_current_node = async (args: ToolArgs, ctx: ToolContext) => {
  const { nodeId } = args;
  
  if (!ctx || !ctx.sessionId) {
    throw new Error('Cannot change node: missing context');
  }

  const session = await sessionManager.getSession(ctx.sessionId);
  if (sessionManager.isSessionEffectivelyIsolated(session)) {
    throw new Error('This session is isolated and cannot switch node via tools. Use /node from the user channel.');
  }
  
  nodesManager.setCurrentNode(ctx.sessionId, nodeId);
  
  // Also update session's currentNode
  session.currentNode = nodeId;
  await sessionManager.saveSession(ctx.sessionId);
  
  return `Current node changed to \`${nodeId}\``;
};

export const definitions = [
        {
            name: 'read',
            description: 'Read a file. Relative paths resolve from the current session cwd when set, otherwise from the current agent folder. Absolute paths and ~/... are also accepted when allowed.',
            parameters: {
                type: 'object',
                properties: { 
                    filePath: { type: 'string' },
                    startLine: { type: 'number', description: 'Starting line number (1-indexed, optional)' },
                    endLine: { type: 'number', description: 'Ending line number (1-indexed, inclusive, optional)' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'write',
            description: 'Write a file to agent-folder.',
            parameters: {
                type: 'object',
                properties: { 
                    content: { type: 'string' },
                    filePath: { type: 'string' },
                    overwrite: { type: 'boolean', description: 'Overwrite existing file. Default: false' }
                },
                required: ['filePath', 'content']
            }
        },
        {
            name: 'edit',
            description: 'Replace exact text in a file (legacy surgical edit). Use oldText/newText for direct single-match replacement. Prefer apply_patch for patch-style changes.',
            parameters: {
                type: 'object',
                properties: { 
                    filePath: { type: 'string' },
                    oldText: { type: 'string', description: 'The exact text to find' },
                    newText: { type: 'string', description: 'The text to replace it with' },
                },
                required: ['filePath', 'oldText', 'newText']
            }
        },
        {
            name: 'apply_patch',
            description: 'This is a custom utility that makes it more convenient to add, remove, or edit code files. Pass the patch command text as `input`. The expected format uses an apply_patch envelope with `*** Begin Patch` / `*** End Patch`, and file actions such as `*** Update File: path`, `*** Add File: path`, or `*** Delete File: path`. Update File bodies use a line-based patch format: optional `@@` / `@@ anchor` section markers, context lines prefixed with a single space, `-` deletions, `+` insertions, and optional `*** End of File`.',
            parameters: {
                type: 'object',
                properties: {
                    input: { type: 'string', description: 'The apply_patch command text that you wish to execute.' }
                },
                required: ['input']
            }
        },
        {
            name: 'read_memory',
            description: 'Read a file from the current agent\'s memory/ directory. Pass a path relative to memory/ (for example `MEMORY.md` or `notes/foo.md`). This always targets your own memory files on master; do not prefix with `memory/` or pass node=master.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
                    startLine: { type: 'number', description: 'Starting line number (1-indexed, optional)' },
                    endLine: { type: 'number', description: 'Ending line number (1-indexed, inclusive, optional)' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'write_memory',
            description: 'Create a new file under the current agent\'s memory/ directory. Pass a path relative to memory/. This tool never overwrites existing files; use edit_memory to modify an existing memory file.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
                    content: { type: 'string', description: 'File contents to create.' }
                },
                required: ['filePath', 'content']
            }
        },
        {
            name: 'edit_memory',
            description: 'Edit an existing file under the current agent\'s memory/ directory using an exact oldText/newText replacement. Pass a path relative to memory/.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
                    oldText: { type: 'string', description: 'The exact text to find' },
                    newText: { type: 'string', description: 'The text to replace it with' }
                },
                required: ['filePath', 'oldText', 'newText']
            }
        },
        {
            name: 'delete_memory',
            description: 'Delete a single file inside the current agent\'s memory/ directory. Pass a path relative to memory/.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'apply_patch_memory',
            description: 'Apply an apply_patch-style patch only within the current agent\'s memory/ directory. Pass memory-relative paths in the patch file headers; `memory/` prefixes are accepted but optional. Supports the same patch envelope and bare-patch compatibility as apply_patch.',
            parameters: {
                type: 'object',
                properties: {
                    input: { type: 'string', description: 'The apply_patch command text to execute against files under the current agent memory/ directory.' }
                },
                required: ['input']
            }
        },
        {
            name: 'list_files',
            description: 'List files under the current agent directory. Can recurse, but path traversal outside the agent folder is blocked.',
            parameters: {
                type: 'object',
                properties: {
                    dirPath: { type: 'string', description: 'Directory path relative to the current agent folder. Defaults to .' },
                    recursive: { type: 'boolean', description: 'Whether to recurse into subdirectories. Default: false' },
                    includeHidden: { type: 'boolean', description: 'Whether to include dotfiles. Default: false' },
                    limit: { type: 'number', description: 'Maximum number of entries to return. Default: 200, max: 1000' }
                }
            }
        },
        {
            name: 'delete_file',
            description: 'Delete a single file or symlink inside the current agent folder. Refuses to delete directories.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'File path relative to the current agent folder.' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'copy_between_nodes',
            description: 'Copy a file between master/remote nodes using the current session agent directory on each endpoint. Paths must be relative to the agent folder.',
            parameters: {
                type: 'object',
                properties: {
                    sourceNode: { type: 'string', description: 'Source node id. Use `master` for local files.' },
                    sourcePath: { type: 'string', description: 'Relative file path inside the current agent folder on the source node.' },
                    targetNode: { type: 'string', description: 'Target node id. Use `master` for local files.' },
                    targetPath: { type: 'string', description: 'Relative file path inside the current agent folder on the target node.' },
                    overwrite: { type: 'boolean', description: 'Overwrite the target file if it already exists. Default: false' },
                },
                required: ['sourceNode', 'sourcePath', 'targetNode', 'targetPath']
            }
        },
        {
            name: 'exec',
            description: 'Execute a shell command in agent-folder. Defaults to the session cwd when set; otherwise uses the agent folder. Output over 10000 tokens is automatically truncated (keeps first/last 5000 tokens), full output saved to agent-folder/.temp/. Commands running longer than the configured timeout (default 15s, allowed range 1-60s) continue in the background and send a completion system message later.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    cwd: { type: 'string', description: 'Optional working directory override. Defaults to session.cwd when set.' },
                    timeout: { type: 'number', minimum: MIN_EXEC_TIMEOUT_SECONDS, maximum: MAX_EXEC_TIMEOUT_SECONDS, description: `Optional timeout in seconds before the command is moved to background. Default: ${DEFAULT_EXEC_TIMEOUT_SECONDS}. Allowed range: ${MIN_EXEC_TIMEOUT_SECONDS}-${MAX_EXEC_TIMEOUT_SECONDS}.` }
                },
                required: ['command']
            }
        },
        {
            name: 'search_vector',
            description: 'Search for relevant past conversations in vector memory within the caller\'s allowed scope. Non-isolated sessions are limited to the current agent; isolated sessions are limited to the current session.',
            parameters: {
                type: 'object',
                properties: { 
                    query: { type: 'string', description: 'The search query' },
                    limit: { type: 'number' },
                    scope: { type: 'string', enum: ['all', 'current-session', 'current-agent'], description: 'Requested scope. It will be capped to the caller\'s allowed range.' },
                    sessionId: { type: 'string', description: 'Optional specific session id, limited to your allowed scope.' },
                    agentName: { type: 'string', description: 'Optional agent name, limited to your current agent.' },
                    includeRegex: { type: 'string', description: 'Optional case-insensitive regex. Results must match this pattern in their text/preview span.' },
                    excludeRegex: { type: 'string', description: 'Optional case-insensitive regex. Results matching this pattern in their text/preview span are filtered out.' },
                    preferBlocks: { type: 'boolean', description: 'If true, give block summary hits a modest ranking boost.' }
                },
                required: ['query']
            }
        },
        {
            name: 'get_memory_context',
            description: 'Retrieve messages around a specific point in time to see conversation flow.',
            parameters: {
                type: 'object',
                properties: { 
                    timestamp: { type: 'number', description: 'The center timestamp to search around' },
                    limit: { type: 'number', description: 'Total messages to fetch' }
                },
                required: ['timestamp']
            }
        },
        {
            name: 'create_child_session',
            description: 'Create a child session. Can either fork (inherit context) or create new (empty). Child sessions should explicitly call send_to_session to report back. If handing off to the child is your final step for this turn, call end_turn afterward in the same response.',
            parameters: {
                type: 'object',
                properties: {
                    suffix: { type: 'string', description: 'Suffix to append to session ID for identification (e.g., "task1", "research")' },
                    fork: { type: 'boolean', description: 'Whether to fork (inherit parent context) or create new session. Default: true', default: true },
                    message: { type: 'string', description: 'Optional initial message to send to the child session immediately after creation' },
                    node: { type: 'string', description: 'Optional node to bind this session (sets currentNode)' }
                },
                required: ['suffix']
            }
        },
        {
            name: 'send_to_session',
            description: 'Send a message to a specific session (including child sessions). The message will be queued and processed by that session. Isolated sessions can only communicate with parent/child sessions. If this handoff is your final step, call end_turn afterward in the same response.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Target session ID' },
                    message: { type: 'string', description: 'Message to send' }
                },
                required: ['sessionId', 'message']
            }
        },
        {
            name: 'end_turn',
            description: 'Stop the current assistant turn after the current batch of tool calls finishes. Use this after handoff tools like send_to_session or create_child_session when you do not want to add any further assistant reply in the current session.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional short note for logs/debugging.' }
                }
            }
        },
        {
            name: 'send_to_channel',
            description: 'Send a message directly to a specific channel target by channelTargetId (<channel-instance-id>:<conversation-id>).',
            parameters: {
                type: 'object',
                properties: {
                    channelTargetId: { type: 'string', description: 'Target channel in format <channel-instance-id>:<conversation-id>' },
                    message: { type: 'string', description: 'Message to send' }
                },
                required: ['channelTargetId', 'message']
            }
        },
        {
            name: 'send_file',
            description: 'Send a local file or image to a specific channel target, or to all non-push-only channels attached to a session. Exactly one of sessionId or channelTargetId is required.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Target session ID whose attached channels should receive the file' },
                    channelTargetId: { type: 'string', description: 'Target channel in format <channel-instance-id>:<conversation-id>' },
                    filePath: { type: 'string', description: 'File path on the selected node. Relative paths are resolved under the current agent folder on that node; absolute paths and ~/... are also accepted when allowed.' },
                    node: { type: 'string', description: 'Optional. Node where the file lives. Defaults to the current node; send_file still delivers through master-side channel/session routing.' },
                    caption: { type: 'string', description: 'Optional caption/text sent with the file where supported' },
                    text: { type: 'string', description: 'Alias of caption for convenience' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'list_sessions',
            description: 'Get list of all sessions with basic info (ID, message count, last message time, channel status)',
            parameters: {
                type: 'object',
                properties: {
                    start: { type: 'number', description: 'Start index in the session list sorted by last activity desc. Default: 0' },
                    count: { type: 'number', description: 'Number of sessions to return. Default: 20' }
                },
                required: [] as string[]
            }
        },
        {
            name: 'list_agents',
            description: 'List all agents with their session counts',
            parameters: {
                type: 'object',
                properties: {},
                required: [] as string[]
            }
        },
        {
            name: 'list_skills',
            description: 'List available skills for the current session agent (or an optionally specified agent), including agent-local, inherited-agent, and global skills.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Optional agent name whose visible skills should be listed. Defaults to the current session agent.' }
                },
                required: [] as string[]
            }
        },
        {
            name: 'load_skill',
            description: 'Load skill documentation content using the current session agent skill resolution (or an optionally specified agent). This only returns skill documents and metadata; it does not dynamically add tools.',
            parameters: {
                type: 'object',
                properties: {
                    skillName: { type: 'string', description: 'Skill name to load' },
                    agentName: { type: 'string', description: 'Optional agent name whose skill search path should be used. Defaults to the current session agent.' }
                },
                required: ['skillName']
            }
        },
        {
            name: 'get_session_messages',
            description: 'Get messages from a session with optional pagination. Defaults to last 10 messages if no parameters specified.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID' },
                    start: { type: 'number', description: 'Start index (0-based, optional). Negative values count from end (e.g., -10 for last 10 messages)' },
                    count: { type: 'number', description: 'Number of messages to retrieve (optional)' },
                    previewLength: { type: 'number', description: 'Maximum length of message preview (default: 100)' }
                },
                required: ['sessionId']
            }
        },
        {
            name: 'get_archived_messages',
            description: 'Read archived session messages from the JSONL archive by seq range. This queries archived history, not just the current working history.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    startSeq: { type: 'number', description: 'Optional inclusive starting seq number' },
                    endSeq: { type: 'number', description: 'Optional inclusive ending seq number' },
                    previewLength: { type: 'number', description: 'Maximum preview length per archived message (default: 1000)' }
                }
            }
        },
        {
            name: 'get_archived_blocks',
            description: 'Read archived layered-context block summaries by block id range for a session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    startId: { type: 'number', description: 'Optional inclusive starting block id' },
                    endId: { type: 'number', description: 'Optional inclusive ending block id' },
                    previewLength: { type: 'number', description: 'Maximum length per block summary preview (default: 1000)' }
                }
            }
        },
        {
            name: 'get_context_archive',
            description: 'Unified archived-context inspection helper. Use this when you want archived raw messages, layered blocks, or both without deciding between separate tools first.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    startSeq: { type: 'number', description: 'Optional inclusive starting raw message seq' },
                    endSeq: { type: 'number', description: 'Optional inclusive ending raw message seq' },
                    startId: { type: 'number', description: 'Optional inclusive starting block id' },
                    endId: { type: 'number', description: 'Optional inclusive ending block id' },
                    includeMessages: { type: 'boolean', description: 'Include archived raw messages (default: auto)' },
                    includeBlocks: { type: 'boolean', description: 'Include archived layered blocks (default: auto)' },
                    previewLength: { type: 'number', description: 'Maximum preview length per returned item (default: 1000)' }
                }
            }
        },
        {
            name: 'delete_session',
            description: 'Delete a session permanently. Cannot delete current session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID to delete' }
                },
                required: ['sessionId']
            }
        },
        {
            name: 'update_session_name',
            description: 'Update the display name of a session. The display name is shown in the session list.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, default: current session)' },
                    name: { type: 'string', description: 'New display name for the session. Use empty string to clear the name.' }
                },
                required: ['name']
            }
        },
        {
            name: 'set_todo',
            description: 'Set or clear a todo reminder for the current session. Recommended workflow: briefly plan first, store only the active checklist here, update it as milestones complete, and clear it when done. Reminders are injected as system messages after enough later session messages have passed, including tool-loop progress.',
            parameters: {
                type: 'object',
                properties: {
                    todo: { type: 'string', description: 'Markdown checklist text like `- [ ] first item`. Use empty string to clear.' },
                    remindEvery: { type: 'number', description: 'Remind after this many later non-reminder session messages.' },
                    clear: { type: 'boolean', description: 'If true, clear the current session todo reminder.' }
                }
            }
        },
        {
            name: 'set_session_child_model',
            description: 'Set, clear, or inspect the per-session default model used when this session creates child or related new sessions. When unset, spawned sessions follow the current session model behavior.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    model: { type: 'string', description: 'Model key to use by default for child/new sessions spawned from this session.' },
                    clear: { type: 'boolean', description: 'If true, clear the override and fall back to following the current session model.' }
                }
            }
        },
        {
            name: 'set_session_compact_threshold',
            description: 'Set, clear, or inspect the per-session auto-compact threshold override in tokens. When unset, the session inherits the default threshold derived from the active model context window.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    thresholdTokens: { type: 'number', description: 'Positive token threshold override for auto-compaction. Omit to inspect current status.' },
                    clear: { type: 'boolean', description: 'If true, clear the session override and inherit the default threshold again.' }
                }
            }
        },
        {
            name: 'update_session_snapshot',
            description: 'Refresh a session prompt snapshot from the latest session-configured memory sources, inheritance, and visible skills catalog. Defaults to the current session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, default: current session)' }
                }
            }
        },
        {
            name: 'stop_session',
            description: 'Stop a running session. Sets a flag that will stop tool call recursion after the current tool completes.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID to stop' }
                },
                required: ['sessionId']
            }
        },
        COMPACT_PLAN_TOOL_DEFINITION,
        {
            name: 'compact_session',
            description: 'Request a compaction flow for the current session or another idle session. This does not return compact candidates directly. Instead, the target session enters a dedicated compaction planning flow where the model must call submit_compact_plan. Use summary only as optional extra guidance for the compaction prompt, not as the final compacted summary.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Target session ID (optional, default: current session)' },
                    summary: { type: 'string', description: 'Optional extra guidance for the compaction prompt. The model must still submit the actual keep/drop plan and final summary via submit_compact_plan.' },
                    keepPercent: { type: 'number', description: 'How much recent history to keep. Use 0-1 fraction or 1-100 percentage. Optional.' }
                }
            }
        },
        {
            name: 'create_timer',
            description: 'Create a one-shot or recurring timer for a session. Timers persist across restarts and deliver structured system events when they fire.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Owner session ID (optional, default: current session)' },
                    at: { type: ['string', 'number'], description: 'Absolute trigger time as ISO string or epoch milliseconds (one-shot)' },
                    afterSeconds: { type: 'number', description: 'Trigger after N seconds (one-shot)' },
                    cron: { type: 'string', description: 'Cron expression for recurring timers' },
                    message: { type: 'string', description: 'Message delivered when the timer fires' },
                    newSession: { type: 'boolean', description: 'If true, each trigger creates a new session instead of using the owner session' },
                    sessionPrefix: { type: 'string', description: 'Prefix for newly created timer sessions (default: timer)' },
                    agentName: { type: 'string', description: 'Target agent for new timer-created sessions (default: owner session agent)' }
                },
                required: ['message']
            }
        },
        {
            name: 'list_timers',
            description: 'List timers for a session. Defaults to the current session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Owner session ID (optional, default: current session)' }
                }
            }
        },
        {
            name: 'delete_timer',
            description: 'Delete a timer by ID. Defaults to the current session scope.',
            parameters: {
                type: 'object',
                properties: {
                    timerId: { type: 'string', description: 'Timer ID to delete' },
                    sessionId: { type: 'string', description: 'Owner session ID (optional, default: current session)' }
                },
                required: ['timerId']
            }
        },
        {
            name: 'browse_open',
            description: 'Open a new browser tab and navigate to URL. Returns tab ID for future operations.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to visit' }
                },
                required: ['url']
            }
        },
        {
            name: 'browse_list',
            description: 'List all open browser tabs with their IDs, titles, and URLs.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'browse_get',
            description: 'Get content or screenshot from a browser tab.',
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: 'Tab ID (e.g., "tab1")' },
                    screenshot: { 
                        type: ['boolean', 'string'], 
                        description: 'If true, return screenshot to LLM for viewing. If a file path (string), save screenshot to that file. If false/omitted, return text content.',
                        default: false 
                    }
                },
                required: ['tabId']
            }
        },
        {
            name: 'browse_close',
            description: 'Close a browser tab.',
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: 'Tab ID to close' }
                },
                required: ['tabId']
            }
        },
        {
            name: 'browse_interact',
            description: 'Interact with a browser tab. Supports: click, type, fill, press (keyboard), scroll, wait, evaluate (JS), goto, back, forward, reload.',
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: 'Tab ID' },
                    action: { 
                        type: 'string', 
                        description: 'Action to perform: click, type, fill, press, scroll, wait, evaluate, goto, back, forward, reload',
                        enum: ['click', 'type', 'fill', 'press', 'scroll', 'wait', 'evaluate', 'goto', 'back', 'forward', 'reload']
                    },
                    params: { 
                        type: 'object', 
                        description: 'Action parameters. Examples: {selector: "#id"}, {selector: "input", text: "hello"}, {key: "Enter"}, {y: 500}, {url: "https://..."}, {code: "document.title"}',
                        properties: {
                            selector: { type: 'string', description: 'CSS selector' },
                            text: { type: 'string', description: 'Text to type/fill' },
                            key: { type: 'string', description: 'Key to press (e.g., Enter, Tab, Escape)' },
                            y: { type: 'number', description: 'Scroll distance in pixels' },
                            url: { type: 'string', description: 'URL to navigate to' },
                            code: { type: 'string', description: 'JavaScript code to evaluate' },
                            timeout: { type: 'number', description: 'Timeout in milliseconds (default: 5000)' }
                        }
                    }
                },
                required: ['tabId', 'action']
            }
        },
        {
            name: 'search_tools',
            description: 'Search or list callable tools across builtin, MCP, and remote-node sources. Builtin results include file/edit tools, exec, session/channel tools, vector/archive tools, timers, and wrapper tools such as MCP/node discovery helpers. Prefer this unified catalog before calling long-tail tools via call_tool. Query text supports multi-word matching and ranks tools that match more of the words higher. For source=`node`, omitting nodeId searches only the current node (falls back to `master` when no current node is available, instead of listing every node). Example search_tools calls: `{query:"read file", sources:["builtin"]}` or `{query:"screenshot android", sources:["node"]}`.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional search query matched against tool names/descriptions. Multi-word queries are split on spaces and ranked by how many words match.' },
                    sources: {
                        type: 'array',
                        description: 'Optional source filter. Defaults to builtin + mcp + node.',
                        items: { type: 'string', enum: ['builtin', 'mcp', 'node'] }
                    },
                    server: { type: 'string', description: 'Optional MCP server name filter.' },
                    nodeId: { type: 'string', description: 'Optional remote node id filter. For source=`node`, omitted means use the current node instead of listing tools from every node.' },
                    limit: { type: 'number', description: 'Maximum number of results to return (default: 20, max: 200).' },
                    includeSchema: { type: 'boolean', description: 'If true (default), include each tool\'s input schema in results.' }
                }
            }
        },
        {
            name: 'call_tool',
            description: 'Unified tool caller for builtin, MCP, and remote-node tools. Prefer toolId returned by search_tools; explicit source/name/server/nodeId fields are also accepted. Always put the target tool arguments inside the required `args` object. Example using toolId: `{toolId:"builtin:read", args:{filePath:"README.md"}}`. Example using explicit MCP fields: `{source:"mcp", server:"github", name:"search_repos", args:{query:"foxwarm"}}`. Example using explicit node fields: `{source:"node", nodeId:"android-node", name:"android_screenshot", args:{inline:true}}`.',
            parameters: {
                type: 'object',
                properties: {
                    toolId: { type: 'string', description: 'Preferred unified tool identifier returned by search_tools (for example builtin:read, mcp:server/tool, node:node-id/tool).' },
                    source: { type: 'string', enum: ['builtin', 'mcp', 'node'], description: 'Explicit source when not using toolId.' },
                    name: { type: 'string', description: 'Tool name when not using toolId.' },
                    server: { type: 'string', description: 'MCP server name for source=mcp.' },
                    nodeId: { type: 'string', description: 'Remote node id for source=node.' },
                    args: { type: 'object', description: 'Required wrapper object containing the target tool arguments. Example: for builtin read, use `args: { filePath: "README.md" }`.' }
                },
                required: ['args']
            }
        },
        {
            name: 'remote_node',
            description: 'Query and execute tools from dynamically registered remote nodes (browser-extension, android, etc). This is for remote hardware/browser nodes, NOT for MCP servers. Use this to discover what tools are available from connected remote nodes, then call them. Example: First call with action="list" to see available nodes and their tools, then call with action="call" to execute a specific tool on a remote node.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'call'],
                        description: 'Action: "list" to see all connected remote nodes and their tools, "call" to execute a specific tool on a remote node'
                    },
                    nodeId: {
                        type: 'string',
                        description: 'Node ID (get from list action, required for call action)'
                    },
                    tool: {
                        type: 'string',
                        description: 'Tool name to call (required when action=call)'
                    },
                    args: {
                        type: 'object',
                        description: 'Tool arguments as key-value pairs (required when action=call)'
                    }
                },
                required: ['action']
            }
        },
        {
            name: 'mcp_config',
            description: 'Configure an MCP server (store in state/mcp.json). Use enable=false to disable an existing server.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Server name' },
                    url: { type: 'string', description: 'Standard MCP server endpoint URL. Use the /mcp endpoint for streamable-http or auto, or the SSE endpoint for sse.' },
                    command: { type: 'string', description: 'Executable to run when transport=stdio.' },
                    args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments for stdio transport.' },
                    env: { type: 'object', description: 'Extra environment variables for stdio transport.' },
                    cwd: { type: 'string', description: 'Working directory for stdio transport.' },
                    stderr: { type: 'string', description: 'How to handle stdio server stderr: inherit, pipe, or ignore.' },
                    token: { type: 'string', description: 'Optional bearer token (sets Authorization: Bearer <token>)' },
                    headers: { type: 'object', description: 'Custom HTTP headers as key-value pairs. Overrides token header if both specified.' },
                    transport: { type: 'string', description: 'Transport type: streamable-http, sse, stdio, or auto. Defaults to auto.' },
                    type: { type: 'string', description: 'Alias for transport (same supported values: streamable-http, sse, stdio, auto).' },
                    description: { type: 'string', description: 'Optional description' },
                    enable: { type: 'boolean', description: 'Enable/disable this server' }
                },
                required: ['name']
            }
        },
        {
            name: 'call_mcp',
            description: 'Call a tool from a configured MCP server. Use search_mcp_tools to list/search available tools first.',
            parameters: {
                type: 'object',
                properties: {
                    server: { type: 'string', description: 'Server name (default: default)' },
                    tool: { type: 'string', description: 'Tool name to call' },
                    args: { type: 'object', description: 'Tool arguments' }
                },
                required: ['tool']
            }
        },
        {
            name: 'search_mcp_tools',
            description: 'Search or list tools from an MCP server. Prefer using query to reduce output size.',
            parameters: {
                type: 'object',
                properties: {
                    server: { type: 'string', description: 'Server name (default: default)' },
                    query: { type: 'string', description: 'Search query (optional)' }
                }
            }
        },
        {
            name: 'list_mcp_servers',
            description: 'List configured MCP servers with safe config summaries. Returns disabled servers too.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'list_nodes',
            description: 'List all registered nodes.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'change_current_node',
            description: 'Change the current node for the session. Execute future tools on the specified node.',
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'Node ID to switch to' }
                },
                required: ['nodeId']
            }
        },
        {
            name: 'create_agent',
            description: 'Create a new persistent agent (workspace + memory container) under agents/{agentName}. By default it also creates the main session, but createMainSession=false keeps only the agent definition. Prefer inherit for shared knowledge and createMainSession/session creation for runnable threads.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Agent name (alphanumeric, hyphens, underscores only)' },
                    inheritMemory: { type: 'boolean', description: 'Legacy compatibility: copy memory files from the source agent into the new agent directory.' },
                    inherit: { type: 'string', description: 'Optional shared-memory parent agent name for agent.inherit.' },
                    isolatedNode: { type: 'string', description: 'Optional non-master node id to make the agent isolated and bound to that node.' },
                    createMainSession: { type: 'boolean', description: 'Whether to also create {agentName}/main (default: true).' },
                    sourceSessionId: { type: 'string', description: 'Optional source session ID to inherit current node/model from (default: current session)' },
                    convertSession: { type: 'boolean', description: 'If true, convert an existing session into the agent main session (requires createMainSession=true).' }
                },
                required: ['agentName']
            }
        },
        {
            name: 'create_session',
            description: 'Create a new session under an existing agent. Prefer this when you need a new conversation thread without duplicating the agent or its memory.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Existing agent name that will own the session.' },
                    sessionName: { type: 'string', description: 'Session name without agent prefix (cannot contain /).' },
                    displayName: { type: 'string', description: 'Optional display name for the new session.' },
                    parentSessionId: { type: 'string', description: 'Optional parent session ID.' },
                    model: { type: 'string', description: 'Optional explicit model key for the new session. When omitted, the current session child-default model behavior is used.' },
                    systemPromptFiles: {
                        type: 'array',
                        description: 'Optional file list for composing the memory-file portion of the new session snapshot. When set, only these files are used as memory sources, while other system injections remain.',
                        items: { type: 'string', description: 'A file path. Relative paths resolve from the agent directory; absolute and ~/ paths are also accepted.' }
                    }
                },
                required: ['agentName', 'sessionName']
            }
        },
        {
            name: 'set_agent_inherit',
            description: 'Set or clear shared memory inheritance for an agent. Inherited memory is injected in root -> ... -> self order without deduplicating same filenames.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Agent whose shared memory inheritance should be updated.' },
                    inheritAgentName: { type: 'string', description: 'Parent agent to inherit shared memory from. Use empty string to clear inheritance.' }
                },
                required: ['agentName']
            }
        },
        {
            name: 'set_agent_isolated',
            description: 'Set or clear agent-level isolation. Isolated agents are bound to a non-master node and their sessions inherit isolated restrictions.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Agent whose isolation setting should be updated.' },
                    nodeId: { type: 'string', description: 'Bound non-master node id. Use empty string to clear isolation.' }
                },
                required: ['agentName']
            }
        },
        {
            name: 'move_session',
            description: 'Move/rename a session, optionally to a different agent or create a new agent. Old session ID becomes an alias.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Source session ID (default: current session)' },
                    newSessionId: { type: 'string', description: 'New session ID without agent prefix (cannot contain /). Default to "main" if createAgent=true.' },
                    createAgent: { type: 'boolean', description: 'Whether to create a new agent (default: false)' },
                    newAgentName: { type: 'string', description: 'Target agent name. Required if createAgent=true or moving to different agent. If omitted, renames within same agent.' },
                    createAgentInheritMemory: { type: 'boolean', description: 'Whether to inherit memory when creating agent (only valid when createAgent=true)' }
                }
            }
        }
    ];

export const modelFacingDefinitions = definitions.filter(def => isToolDirectlyExposedToModel(def.name));
