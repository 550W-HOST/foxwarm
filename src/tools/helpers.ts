import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import * as sessionManager from '../sessionManager';
import { WORKSPACE_DIR, getAgentMemoryDir } from '../config';
import { checkPathAccess } from '../isolatedCheck';
import { applyUpdatePatch, buildAddedFileContent, parseApplyPatchInput } from '../applyPatch';
import { expandHomePath, resolveAgentPath } from '../utils/pathResolve';
import {
    findWriteParentIssue,
    formatWriteParentIssueMessage,
    readFileToolPath,
    writeFileToolPath,
    type WriteParentIssue,
} from '../../packages/shared/dist/fileToolCore';

export { expandHomePath, resolveAgentPath };
export { findWriteParentIssue, formatWriteParentIssueMessage, type WriteParentIssue };

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

export function peekPendingWriteRefContent(ctx: ToolContext, agentName: string, refId: string, fullPath: string): string {
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

    return ref.content;
}

export function deletePendingWriteRef(refId: string): void {
    pendingWriteRefs.delete(refId);
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

export async function readResolvedPath(fullPath: string, displayPath: string, startLine?: number, endLine?: number) {
    return readFileToolPath(fullPath, displayPath, startLine, endLine);
}

export async function writeResolvedPath(fullPath: string, content: string, overwrite: boolean, existsMessage: string | (() => string), options?: { createDirs?: boolean; parentIssueRetryHint?: (issue: WriteParentIssue) => string | undefined }) {
    await writeFileToolPath(fullPath, content, {
        overwrite,
        existsMessage,
        createDirs: options?.createDirs,
        parentIssueRetryHint: options?.parentIssueRetryHint,
    });
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

    for (let idx = 0; idx < operations.length; idx++) {
        const operation = operations[idx];
        const { fullPath, displayPath } = resolveOperationPath(operation.filePath);

        try {
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
        } catch (err) {
            const succeeded = summaries.length > 0
                ? `\nOperations already applied (these changes are already on disk):\n${summaries.map(line => `- ${line}`).join('\n')}\n`
                : '';
            const remaining = operations.length - idx - 1;
            const remainingHint = remaining > 0 ? `\n${remaining} remaining operation(s) were not applied.` : '';
            throw new Error(`${(err as Error).message}${succeeded}${remainingHint}`);
        }
    }

    return `Patch applied successfully.\n${summaries.map(line => `- ${line}`).join('\n')}`;
}

export function enforceIsolatedPathAccess(ctx: ToolContext | undefined, fullPath: string, agentName: string) {
    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }
}
