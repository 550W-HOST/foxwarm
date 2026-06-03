import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import * as sessionManager from '../sessionManager';
import { WORKSPACE_DIR, getAgentMemoryDir } from '../config';
import { checkPathAccess } from '../isolatedCheck';
import { applyUpdatePatch, buildAddedFileContent, parseApplyPatchInput } from '../applyPatch';
import { expandHomePath, resolveAgentPath } from '../utils/pathResolve';

export { expandHomePath, resolveAgentPath };

// Tool context type
export interface ToolContext {
    sessionId?: string;
    session?: any;
    broadcast?: (text: string, options?: any) => Promise<void>;
    queueSystemEvent?: (message: string, type?: 'background' | 'trigger' | 'onboot') => Promise<void>;
    runtimeNodeId?: string;
}

// Tool function type
export type ToolArgs = Record<string, any>;
export type UnifiedToolSource = 'builtin' | 'mcp' | 'node';

export type PendingWriteRef = {
    id: string;
    scopeKey: string;
    agentName: string;
    fullPath: string;
    displayPath: string;
    content: string;
    createdAt: number;
    expiresAt: number;
    sizeBytes: number;
};

export const WORKSPACE = WORKSPACE_DIR;

export const PENDING_WRITE_REF_TTL_MS = 15 * 60 * 1000;
export const PENDING_WRITE_REF_MAX_ENTRIES = 32;
export const PENDING_WRITE_REF_MAX_CONTENT_BYTES = 2 * 1024 * 1024;
export const PENDING_WRITE_REF_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const pendingWriteRefs = new Map<string, PendingWriteRef>();

export function getPendingWriteScopeKey(ctx: ToolContext, agentName: string): string {
    return ctx.sessionId ? `session:${ctx.sessionId}` : `agent:${agentName}`;
}

export function prunePendingWriteRefs(now = Date.now()) {
    for (const [id, ref] of pendingWriteRefs.entries()) {
        if (ref.expiresAt <= now) {
            pendingWriteRefs.delete(id);
        }
    }

    while (pendingWriteRefs.size > PENDING_WRITE_REF_MAX_ENTRIES) {
        const oldest = [...pendingWriteRefs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!oldest) break;
        pendingWriteRefs.delete(oldest.id);
    }

    let totalBytes = [...pendingWriteRefs.values()].reduce((sum, ref) => sum + ref.sizeBytes, 0);
    while (totalBytes > PENDING_WRITE_REF_MAX_TOTAL_BYTES) {
        const oldest = [...pendingWriteRefs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!oldest) break;
        pendingWriteRefs.delete(oldest.id);
        totalBytes -= oldest.sizeBytes;
    }
}

export function registerPendingWriteRef(ctx: ToolContext, agentName: string, fullPath: string, displayPath: string, content: string): PendingWriteRef | null {
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > PENDING_WRITE_REF_MAX_CONTENT_BYTES) {
        return null;
    }

    const now = Date.now();
    prunePendingWriteRefs(now);
    const id = `write_${crypto.randomBytes(6).toString('hex')}`;
    const ref: PendingWriteRef = {
        id,
        scopeKey: getPendingWriteScopeKey(ctx, agentName),
        agentName,
        fullPath,
        displayPath,
        content,
        createdAt: now,
        expiresAt: now + PENDING_WRITE_REF_TTL_MS,
        sizeBytes,
    };
    pendingWriteRefs.set(id, ref);
    prunePendingWriteRefs(now);
    return ref;
}

export function consumePendingWriteRef(ctx: ToolContext, agentName: string, refId: string, fullPath: string): string {
    prunePendingWriteRefs();
    const ref = pendingWriteRefs.get(refId);
    if (!ref) {
        throw new Error(`Pending write contentRef not found or expired: ${refId}. Re-run write with content, or use a fresh contentRef from the previous write error.`);
    }
    if (ref.scopeKey !== getPendingWriteScopeKey(ctx, agentName) || ref.agentName !== agentName) {
        throw new Error(`Pending write contentRef ${refId} is not available in this session/agent.`);
    }
    if (path.resolve(ref.fullPath) !== path.resolve(fullPath)) {
        throw new Error(`Pending write contentRef ${refId} was created for ${ref.displayPath}; it cannot be used to write a different file.`);
    }

    pendingWriteRefs.delete(refId);
    return ref.content;
}

export type WriteParentIssue = {
    path: string;
    reason: 'missing' | 'not-directory';
};

export async function findWriteParentIssue(fullPath: string): Promise<WriteParentIssue | null> {
    const parentDir = path.resolve(path.dirname(fullPath));
    const root = path.parse(parentDir).root;
    const relativeParent = path.relative(root, parentDir);

    if (!relativeParent) {
        return null;
    }

    let current = root;
    for (const part of relativeParent.split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let stats: any;
        try {
            stats = await fs.lstat(current);
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                return { path: current, reason: 'missing' };
            }
            throw err;
        }
        if (!stats.isDirectory()) {
            return { path: current, reason: 'not-directory' };
        }
    }

    return null;
}

export function formatWriteParentIssueMessage(issue: WriteParentIssue, retryHint?: string): string {
    const base = issue.reason === 'missing'
        ? `Parent directory does not exist: ${issue.path}. write does not create parent directories by default. Retry with createDirs=true to create missing parent directories.`
        : `Parent path is not a directory: ${issue.path}.`;
    return retryHint ? `${base}${retryHint}` : base;
}

export function shouldEnforceIsolatedMasterPathAccess(ctx: ToolContext | undefined): boolean {
    return sessionManager.isSessionEffectivelyIsolated(ctx?.session) && (ctx?.runtimeNodeId || 'master') === 'master';
}

export function normalizeMemoryRelativePath(filePath: string): string {
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

export function resolveAgentMemoryPath(filePath: string, agentName: string = 'main'): string {
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

type DirectoryListingEntry = {
    name: string;
    type: 'file' | 'directory' | 'symlink' | 'other';
    size?: number;
    modifiedAt: string;
};

function normalizeOptionalLineBound(value: number | undefined): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric === 0) {
        return undefined;
    }
    return numeric;
}

function normalizeDirectoryListingStartEnd(startLine: number | undefined, endLine: number | undefined, totalItems: number): { startItem: number; endItem: number } {
    const normalizedStartLine = normalizeOptionalLineBound(startLine);
    const normalizedEndLine = normalizeOptionalLineBound(endLine);
    const startItem = normalizedStartLine !== undefined
        ? Math.max(1, Math.floor(Number(normalizedStartLine)))
        : 1;
    const endItem = normalizedEndLine !== undefined
        ? Math.max(0, Math.floor(Number(normalizedEndLine)))
        : Math.min(totalItems, startItem + 49);
    return { startItem, endItem };
}

function formatDirectoryListingLine(entry: DirectoryListingEntry, itemNumber: number): string {
    const name = entry.type === 'directory' ? `${entry.name}/` : entry.name;
    const sizeLabel = entry.type === 'file' && typeof entry.size === 'number' ? `, ${entry.size} B` : '';
    const typeLabel = entry.type === 'directory' ? 'dir' : entry.type;
    return `${itemNumber}. \`${name}\` (${typeLabel}${sizeLabel}) - ${entry.modifiedAt}`;
}

async function readDirectoryListing(fullPath: string, displayPath: string, startLine?: number, endLine?: number): Promise<string> {
    const dirents = await fs.readdir(fullPath, { withFileTypes: true });
    dirents.sort((a, b) => a.name.localeCompare(b.name));

    const entries: DirectoryListingEntry[] = [];
    for (const dirent of dirents) {
        const entryPath = path.join(fullPath, dirent.name);
        const entryStats = await fs.lstat(entryPath);
        entries.push({
            name: dirent.name,
            type: dirent.isDirectory() ? 'directory' : (dirent.isFile() ? 'file' : (dirent.isSymbolicLink() ? 'symlink' : 'other')),
            size: dirent.isFile() ? entryStats.size : undefined,
            modifiedAt: entryStats.mtime.toISOString(),
        });
    }

    const totalItems = entries.length;
    const { startItem, endItem } = normalizeDirectoryListingStartEnd(startLine, endLine, totalItems);
    const pageEntries = startItem <= endItem
        ? entries.slice(Math.max(0, startItem - 1), Math.min(totalItems, endItem))
        : [];

    const lines: string[] = [
        `Directory listing for \`${displayPath}\``,
        '',
    ];

    if (pageEntries.length === 0) {
        lines.push(totalItems === 0 ? '(empty directory)' : '(no items in requested range)');
    } else {
        lines.push(...pageEntries.map((entry, index) => formatDirectoryListingLine(entry, startItem + index)));
    }

    lines.push('');
    const shownStart = pageEntries.length > 0 ? startItem : 0;
    const shownEnd = pageEntries.length > 0 ? startItem + pageEntries.length - 1 : 0;
    const footer = [`Showing items ${shownStart}-${shownEnd} of ${totalItems}.`];
    const nextStart = startItem + pageEntries.length;
    if (nextStart <= totalItems) {
        const nextEnd = Math.min(totalItems, nextStart + 49);
        footer.push(`Next page: read({ filePath: ${JSON.stringify(displayPath)}, startLine: ${nextStart}, endLine: ${nextEnd} })`);
    }
    lines.push(footer.join(' '));

    return lines.join('\n');
}

export async function readResolvedPath(fullPath: string, displayPath: string, startLine?: number, endLine?: number) {
    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) {
        return readDirectoryListing(fullPath, displayPath, startLine, endLine);
    }

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

    const normalizedStartLine = normalizeOptionalLineBound(startLine);
    const normalizedEndLine = normalizeOptionalLineBound(endLine);

    if (normalizedStartLine !== undefined || normalizedEndLine !== undefined) {
        const lines = content.split('\n');
        const start = normalizedStartLine !== undefined ? Math.max(0, normalizedStartLine - 1) : 0;
        const end = normalizedEndLine !== undefined ? Math.min(lines.length, normalizedEndLine) : lines.length;
        content = lines.slice(start, end).join('\n');
    }

    return content;
}

export async function writeResolvedPath(fullPath: string, content: string, overwrite: boolean, existsMessage: string, options?: { createDirs?: boolean }) {
    const exists = await fs.pathExists(fullPath);
    if (exists && !overwrite) {
        throw new Error(existsMessage);
    }

    if (options?.createDirs === true) {
        await fs.ensureDir(path.dirname(fullPath));
    } else {
        const parentIssue = await findWriteParentIssue(fullPath);
        if (parentIssue) {
            throw new Error(formatWriteParentIssueMessage(parentIssue));
        }
    }
    await fs.writeFile(fullPath, content);
}

export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyExactReplacement(content: string, searchText: string, replaceText: string, label: string): string {
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

export async function editResolvedPath(fullPath: string, oldText: string, newText: string) {
    const content = await fs.readFile(fullPath, 'utf8');

    if (typeof oldText !== 'string' || typeof newText !== 'string') {
        throw new Error('Edit tool requires oldText and newText. Use apply_patch for patch-style edits.');
    }

    const updatedContent = applyExactReplacement(content, oldText, newText, 'oldText');
    await fs.writeFile(fullPath, updatedContent);
}

export async function deleteResolvedPath(fullPath: string, displayPath: string) {
    const stats = await fs.lstat(fullPath);
    if (stats.isDirectory()) {
        throw new Error(`Cannot delete directory: ${displayPath}`);
    }

    await fs.remove(fullPath);
}

export async function applyPatchOperations(input: string, resolveOperationPath: (filePath: string) => {
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

export function enforceIsolatedPathAccess(ctx: ToolContext | undefined, fullPath: string, agentName: string) {
    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }
}
