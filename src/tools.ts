import fs from 'fs-extra';
import path from 'path';
import * as vector from './vector';
import * as sessionManager from './sessionManager';
import { estimateTokenCount } from './tokenCount';
import { WORKSPACE_DIR, getAgentDir, getAgentMemoryDir } from './config';
import { checkPathAccess } from './isolatedCheck';
import * as mcpClient from './mcpClient';
import { browserManager } from './browser';
import { logger } from './common';
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
import {
    tool_create_child_session,
    tool_send_to_session,
    tool_send_to_channel,
    tool_send_file,
    tool_list_sessions,
    tool_list_agents,
    tool_list_skills,
    tool_attach_agent_skill,
    tool_detach_agent_skill,
    tool_load_skill,
    tool_get_session_messages,
    tool_get_archived_messages,
    tool_get_archived_blocks,
    tool_delete_session,
    tool_update_session_name,
    tool_set_todo,
    tool_set_session_compact_threshold,
    tool_update_session_snapshot,
    tool_stop_session,
    tool_compact_session,
    tool_compress_session,
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

const WORKSPACE = WORKSPACE_DIR;
fs.ensureDirSync(getAgentDir('main'));

const OPTIONAL_NODE_DESCRIPTION = 'Optional. Empty = current node; avoid `current`.';

// Helper function to resolve file path for agent
function resolveAgentPath(filePath: string, agentName: string = 'main'): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }

    // Relative path - resolve to agent folder
    const agentDir = getAgentDir(agentName);
    const resolved = path.resolve(agentDir, filePath);

    // Path traversal protection
    if (!(resolved === agentDir || resolved.startsWith(agentDir + path.sep))) {
        throw new Error('Path traversal detected: cannot access files outside agent folder');
    }

    return resolved;
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
    return tokens > 10000 ? `[TOO LONG (~${tokens} tokens), TRUNCATED. showing first 10000 chars only.]\n${content.slice(0, 10000)}` : content;
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
    const fullPath = resolveAgentPath(filePath, agentName);
    return readResolvedPath(fullPath, filePath, startLine, endLine);
}

async function tool_write(args: ToolArgs, ctx: ToolContext) {
    const { filePath, content, overwrite } = args;
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName);
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
    const fullPath = resolveAgentPath(filePath, agentName);
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

async function tool_apply_patch(args: ToolArgs, ctx: ToolContext) {
    const { input } = args;

    if (!input || typeof input !== 'string') {
        throw new Error('apply_patch requires input string.');
    }

    const agentName = ctx.session?.agent || 'main';
    const operations = parseApplyPatchInput(input);
    const summaries: string[] = [];

    for (const operation of operations) {
        const fullPath = resolveAgentPath(operation.filePath, agentName);

        if (operation.action === 'update') {
            if (!await fs.pathExists(fullPath)) {
                throw new Error(`Cannot update missing file: ${operation.filePath}`);
            }
            const content = await fs.readFile(fullPath, 'utf8');
            const updatedContent = applyUpdatePatch(content, operation.lines, operation.filePath);
            await fs.writeFile(fullPath, updatedContent);
            summaries.push(`Updated ${operation.filePath}`);
            continue;
        }

        if (operation.action === 'add') {
            if (await fs.pathExists(fullPath)) {
                throw new Error(`Cannot add file that already exists: ${operation.filePath}`);
            }
            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, buildAddedFileContent(operation.lines));
            summaries.push(`Added ${operation.filePath}`);
            continue;
        }

        if (!await fs.pathExists(fullPath)) {
            throw new Error(`Cannot delete missing file: ${operation.filePath}`);
        }
        await fs.remove(fullPath);
        summaries.push(`Deleted ${operation.filePath}`);
    }

    return `Patch applied successfully.\n${summaries.map(line => `- ${line}`).join('\n')}`;
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
    const fullPath = resolveAgentPath(dirPath, agentName);

    if (sessionManager.isSessionEffectivelyIsolated(ctx.session)) {
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
    const fullPath = resolveAgentPath(filePath, agentName);

    if (sessionManager.isSessionEffectivelyIsolated(ctx.session)) {
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
    const { command, cwd } = args;

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

    const status = await waitForExecCompletion(execEntry.id, 15000);
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
    const result = await buildBackgroundTimeoutResult(execEntry);
    return cwdNotice ? `${cwdNotice}\n\n${result}` : result;
}

async function tool_change_directory(args: ToolArgs, ctx: ToolContext) {
    const { path: targetPath } = args;

    if (!ctx.sessionId || !ctx.session) {
        throw new Error('change_directory requires an active session context.');
    }
    if (typeof targetPath !== 'string' || targetPath.trim().length === 0) {
        throw new Error('path is required');
    }

    const agentName = ctx.session.agent || 'main';
    const resolvedPath = resolveExecCwd(targetPath, ctx, agentName);
    if (!resolvedPath) {
        throw new Error('path is required');
    }

    const nodeId = ctx.runtimeNodeId || ctx.session.currentNode || 'master';
    if (nodeId === 'master') {
        let stat: fs.Stats | null = null;
        try {
            stat = await fs.stat(resolvedPath);
        } catch {
            stat = null;
        }
        if (!stat) {
            throw new Error(`Directory does not exist: ${resolvedPath}`);
        }
        if (!stat.isDirectory()) {
            throw new Error(`Path is not a directory: ${resolvedPath}`);
        }
    } else {
        await nodesManager.executeTool(nodeId, 'exec', { command: 'pwd', cwd: resolvedPath }, ctx.sessionId);
    }

    const changed = await sessionManager.setSessionCwd(ctx.sessionId, resolvedPath);
    if (!changed.changed) {
        return `Working directory unchanged: \`${resolvedPath}\`.`;
    }

    return changed.previous
        ? `Working directory changed: \`${changed.previous}\` → \`${resolvedPath}\`.`
        : `Working directory changed to \`${resolvedPath}\`.`;
}

export async function resolveMemorySearchOptions(
    request: {
        scope?: 'all' | 'current-session' | 'current-agent';
        targetSessionId?: string;
        targetAgentName?: string;
    },
    ctx?: ToolContext,
): Promise<{ searchOptions: { sessionIds?: string[]; agent?: string }; effectiveScope: 'current-session' | 'current-agent' }> {
    if (!ctx?.sessionId) {
        throw new Error('search_memory requires an active session context.');
    }

    const session = await sessionManager.getSession(ctx.sessionId);
    const agentName = session.agent || 'main';
    const effectiveIsolated = sessionManager.isSessionEffectivelyIsolated(session);

    if (effectiveIsolated) {
        if (request.targetAgentName && request.targetAgentName !== agentName) {
            throw new Error('Isolated session can only search the current session.');
        }
        if (request.targetSessionId && request.targetSessionId !== session.id && !(session.aliases || []).includes(request.targetSessionId)) {
            throw new Error('Isolated session can only search the current session.');
        }
        return {
            searchOptions: { sessionIds: [session.id, ...(session.aliases || [])] },
            effectiveScope: 'current-session',
        };
    }

    if (request.targetAgentName && request.targetAgentName !== agentName) {
        throw new Error('search_memory cannot access memories outside the current agent.');
    }

    if (request.targetSessionId) {
        const targetSession = await sessionManager.getExistingSession(request.targetSessionId);
        if (!targetSession) {
            throw new Error(`Session \`${request.targetSessionId}\` not found.`);
        }
        if ((targetSession.agent || 'main') !== agentName) {
            throw new Error('search_memory cannot access memories outside the current agent.');
        }
        return {
            searchOptions: { sessionIds: [targetSession.id, ...(targetSession.aliases || [])] },
            effectiveScope: 'current-session',
        };
    }

    if (request.scope === 'current-session') {
        return {
            searchOptions: { sessionIds: [session.id, ...(session.aliases || [])] },
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

async function tool_search_memory({ query, limit = 5, scope = 'all', sessionId, agentName }: { query: string; limit?: number; scope?: 'all' | 'current-session' | 'current-agent'; sessionId?: string; agentName?: string }, ctx?: ToolContext) {
    const { searchOptions } = await resolveMemorySearchOptions({
        scope,
        targetSessionId: sessionId,
        targetAgentName: agentName,
    }, ctx);

    const results = await vector.search(query, limit, false, searchOptions);
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

async function tool_remote_node(args: ToolArgs, ctx: ToolContext) {
    const { action, nodeId, tool, args: toolArgs } = args;
    
    // Get session for isolated check
    const session = ctx.sessionId ? await sessionManager.getExistingSession(ctx.sessionId) : undefined;
    
    // Isolated sessions can only call tools on their bound node
    if (sessionManager.isSessionEffectivelyIsolated(session) && action === 'call') {
        const currentNode = sessionManager.getAgentIsolationNode(session?.agent || 'main') || session?.currentNode || 'master';
        if (nodeId !== currentNode) {
            throw new Error('Isolated session can only call tools on its bound node.');
        }
    }
    
    if (action === 'list') {
        // List all nodes and their tools
        const nodes = nodesManager.listNodesWithTools();
        return {
            nodes: nodes.map((n: any) => ({
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

export const read = tool_read;
export const write = tool_write;
export const edit = tool_edit;
export const read_memory = tool_read_memory;
export const write_memory = tool_write_memory;
export const edit_memory = tool_edit_memory;
export const delete_memory = tool_delete_memory;
export const apply_patch = tool_apply_patch;
export const list_files = tool_list_files;
export const delete_file = tool_delete_file;
export const copy_between_nodes = tool_copy_between_nodes;
export const exec = tool_exec;
export const change_directory = tool_change_directory;
export const search_memory = tool_search_memory;
export const get_memory_context = tool_get_memory_context;
export const create_child_session = tool_create_child_session;
export const create_agent = tool_create_agent;
export const create_session = tool_create_session;
export const set_agent_inherit = tool_set_agent_inherit;
export const set_agent_isolated = tool_set_agent_isolated;
export const move_session = tool_move_session;
export const send_to_session = tool_send_to_session;
export const send_to_channel = tool_send_to_channel;
export const send_file = tool_send_file;
export const list_sessions = tool_list_sessions;
export const list_agents = tool_list_agents;
export const list_skills = tool_list_skills;
export const attach_agent_skill = tool_attach_agent_skill;
export const detach_agent_skill = tool_detach_agent_skill;
export const load_skill = tool_load_skill;
export const get_session_messages = tool_get_session_messages;
export const get_archived_messages = tool_get_archived_messages;
export const get_archived_blocks = tool_get_archived_blocks;
export const delete_session = tool_delete_session;
export const update_session_name = tool_update_session_name;
export const set_todo = tool_set_todo;
export const set_session_compact_threshold = tool_set_session_compact_threshold;
export const update_session_snapshot = tool_update_session_snapshot;
export const stop_session = tool_stop_session;
export const compact_session = tool_compact_session;
export const compress_session = tool_compress_session;
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
            description: 'Read a file from agent-folder.',
            parameters: {
                type: 'object',
                properties: { 
                    filePath: { type: 'string' },
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION },
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
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION },
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
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION }
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
                    input: { type: 'string', description: 'The apply_patch command text that you wish to execute.' },
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION }
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
            name: 'list_files',
            description: 'List files under the current agent directory. Can recurse, but path traversal outside the agent folder is blocked.',
            parameters: {
                type: 'object',
                properties: {
                    dirPath: { type: 'string', description: 'Directory path relative to the current agent folder. Defaults to .' },
                    recursive: { type: 'boolean', description: 'Whether to recurse into subdirectories. Default: false' },
                    includeHidden: { type: 'boolean', description: 'Whether to include dotfiles. Default: false' },
                    limit: { type: 'number', description: 'Maximum number of entries to return. Default: 200, max: 1000' },
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION }
                }
            }
        },
        {
            name: 'delete_file',
            description: 'Delete a single file or symlink inside the current agent folder. Refuses to delete directories.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'File path relative to the current agent folder.' },
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION }
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
            description: 'Execute a shell command in agent-folder. Defaults to the session cwd when set; otherwise uses the agent folder. Output over 10000 tokens is automatically truncated (keeps first/last 5000 tokens), full output saved to agent-folder/.temp/. Commands running over 15 seconds will time out, continue in the background, and send a completion system message later.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    cwd: { type: 'string', description: 'Optional working directory override. Defaults to session.cwd when set.' }
                },
                required: ['command']
            }
        },
        {
            name: 'change_directory',
            description: 'Change the current session working directory (session.cwd). Relative paths resolve from the current session cwd when set, otherwise from the agent folder.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Target directory path. May be absolute or relative.' }
                },
                required: ['path']
            }
        },
        {
            name: 'search_memory',
            description: 'Search for relevant past conversations in vector memory within the caller\'s allowed scope. Non-isolated sessions are limited to the current agent; isolated sessions are limited to the current session.',
            parameters: {
                type: 'object',
                properties: { 
                    query: { type: 'string', description: 'The search query' },
                    limit: { type: 'number' },
                    scope: { type: 'string', enum: ['all', 'current-session', 'current-agent'], description: 'Requested scope. It will be capped to the caller\'s allowed range.' },
                    sessionId: { type: 'string', description: 'Optional specific session id, limited to your allowed scope.' },
                    agentName: { type: 'string', description: 'Optional agent name, limited to your current agent.' }
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
            description: 'Create a child session. Can either fork (inherit context) or create new (empty). Child sessions should explicitly call send_to_session to report back. Set noFurtherAssistantReply=true when creating/delegating to the child is your final step for this turn and you do not want another reply in the current session.',
            parameters: {
                type: 'object',
                properties: {
                    suffix: { type: 'string', description: 'Suffix to append to session ID for identification (e.g., "task1", "research")' },
                    fork: { type: 'boolean', description: 'Whether to fork (inherit parent context) or create new session. Default: true', default: true },
                    message: { type: 'string', description: 'Optional initial message to send to the child session immediately after creation' },
                    noFurtherAssistantReply: { type: 'boolean', description: 'If true, stop the current assistant turn immediately after creating the child (and after sending the optional initial message). Use when the handoff itself is the whole reply and no extra reply is needed here.' },
                    node: { type: 'string', description: 'Optional node to bind this session (sets currentNode)' }
                },
                required: ['suffix']
            }
        },
        {
            name: 'send_to_session',
            description: 'Send a message to a specific session (including child sessions). The message will be queued and processed by that session. Isolated sessions can only communicate with parent/child sessions. Set noFurtherAssistantReply=true when this handoff message is your final step and the current session should stop without another reply.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Target session ID' },
                    message: { type: 'string', description: 'Message to send' },
                    noFurtherAssistantReply: { type: 'boolean', description: 'If true, send this handoff message and stop the current assistant turn immediately. Use when no extra reply is needed in the current session after the handoff.' }
                },
                required: ['sessionId', 'message']
            }
        },
        {
            name: 'send_to_channel',
            description: 'Send a message directly to a specific channel by channelId (platform:userId).',
            parameters: {
                type: 'object',
                properties: {
                    channelId: { type: 'string', description: 'Channel ID in format platform:userId' },
                    message: { type: 'string', description: 'Message to send' }
                },
                required: ['channelId', 'message']
            }
        },
        {
            name: 'send_file',
            description: 'Send a local file or image to a specific channel, or to all non-push-only channels attached to a session. Exactly one of sessionId or channelId is required.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Target session ID whose attached channels should receive the file' },
                    channelId: { type: 'string', description: 'Target channel ID in format platform:userId' },
                    filePath: { type: 'string', description: 'Local file path. Relative paths are resolved under the current agent folder; absolute paths are also accepted.' },
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
            name: 'attach_agent_skill',
            description: 'Attach a skill to an agent. This updates the agent metadata and refreshes session prompt snapshots for that agent.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Target agent name' },
                    skillName: { type: 'string', description: 'Skill name to attach' }
                },
                required: ['agentName', 'skillName']
            }
        },
        {
            name: 'detach_agent_skill',
            description: 'Detach a skill from an agent. This updates the agent metadata and refreshes session prompt snapshots for that agent.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Target agent name' },
                    skillName: { type: 'string', description: 'Skill name to detach' }
                },
                required: ['agentName', 'skillName']
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
            description: 'Set or clear a todo reminder for the current session. Reminders are injected as system messages after enough later session messages have passed, including tool-loop progress.',
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
            description: 'Refresh a session prompt snapshot from the latest agent memory, inheritance, and attached skills. Defaults to the current session.',
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
            name: 'compress_session',
            description: 'Compatibility alias of compact_session.',
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
                    url: { type: 'string', description: 'URL to visit' },
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION }
                },
                required: ['url']
            }
        },
        {
            name: 'browse_list',
            description: 'List all open browser tabs with their IDs, titles, and URLs.',
            parameters: {
                type: 'object',
                properties: {
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION }
                }
            }
        },
        {
            name: 'browse_get',
            description: 'Get content or screenshot from a browser tab.',
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: 'Tab ID (e.g., "tab1")' },
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION },
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
                    tabId: { type: 'string', description: 'Tab ID to close' },
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION }
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
                    node: { type: 'string', description: OPTIONAL_NODE_DESCRIPTION },
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
                    parentSessionId: { type: 'string', description: 'Optional parent session ID.' }
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
