import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import * as sessionManager from '../sessionManager';
import { WORKSPACE_DIR, getAgentMemoryDir } from '../config';
import { checkPathAccess } from '../isolatedCheck';
import { expandHomePath, resolveAgentPath } from '../utils/pathResolve';
import {
    findWriteParentIssue,
    formatWriteContentRefRetryHint,
    formatWriteParentIssueMessage,
    requireToolFilePath,
    readFileToolPath,
    writeFileToolPath,
    type WriteParentIssue,
} from '../../packages/shared/dist/fileToolCore';
import type { ToolScriptSubCall, LinkedTaskCompletion } from '../types';
import type { ExecRuntime } from '../execManager';
import type { ResolvedToolPath } from '../../packages/shared/dist/resolvedPathMetadata';
import {
    nativeFileOperations,
    readWholeFile,
    type FileOperations,
} from '../../packages/shared/dist/fileOperations';

export { expandHomePath, resolveAgentPath };
export { findWriteParentIssue, formatWriteContentRefRetryHint, formatWriteParentIssueMessage, requireToolFilePath, type WriteParentIssue };

// Tool context type
export interface ToolContext {
    sessionId?: string;
    session?: any;
    broadcast?: (text: string, options?: any) => Promise<void>;
    queueSystemEvent?: (message: string, type?: 'background' | 'trigger' | 'onboot') => Promise<void>;
    runtimeNodeId?: string;
    /** Resolved-target file primitives; local production uses the native backend. */
    fileOperations?: FileOperations;
    deferSessionCwdSync?: boolean;
    /** Trusted producer hint for script data, never derived from tool arguments. */
    programmatic?: true;
    /** In-process owner hook for persisting ctx.session; never serialized as a tool/RPC DTO. */
    persistCurrentSession?: () => Promise<void>;
    /** Main-local detached read marker; permits read helpers to trust ctx.session without hydration or persistence. */
    detachedReadOnlySession?: true;
    /** Detached exact-owner exec invocation already persists through Session runtime settings; skip eager full-session save. */
    skipExecPreSave?: true;
    /** Process-local exec owner; never serialized as a tool/RPC DTO. */
    execRuntime?: ExecRuntime;
    /** Captured owner routing/cwd for one local parallel tool segment. */
    toolExecutionSnapshot?: { currentNode: string; cwd?: string };
    /** Trusted in-process placement, supplied by turn effects and never tool arguments. */
    sessionPlacement?: 'local' | 'session-worker';
    /** Per-invocation UI-only file paths, never included in model-visible tool results. */
    onResolvedPaths?: (paths: ResolvedToolPath[]) => void;
    /** Per-invocation ToolScript activity for persisted UI metadata, never model-visible result data. */
    onToolScriptSubCalls?: (subCalls: ToolScriptSubCall[]) => void;
    /** In-process receipt of a real builtin Task completion; never a tool argument or RPC callback. */
    onLinkedTaskCompletion?: (completion: LinkedTaskCompletion) => void;
}

// Tool function type
export type ToolArgs = Record<string, any>;
export type UnifiedToolSource = 'builtin' | 'mcp' | 'node';

export type PendingWriteRef = {
    id: string;
    scopeKey: string;
    agentName: string;
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

export function registerPendingWriteRef(ctx: ToolContext, agentName: string, content: string): PendingWriteRef | null {
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
        content,
        createdAt: now,
        expiresAt: now + PENDING_WRITE_REF_TTL_MS,
        sizeBytes,
    };
    pendingWriteRefs.set(id, ref);
    prunePendingWriteRefs(now);
    return ref;
}

export function peekPendingWriteRefContent(ctx: ToolContext, agentName: string, refId: string): string {
    prunePendingWriteRefs();
    const ref = pendingWriteRefs.get(refId);
    if (!ref) {
        throw new Error(`Pending write contentRef not found or expired: ${refId}. Re-run write with content, or use a fresh contentRef from the previous write error.`);
    }
    if (ref.scopeKey !== getPendingWriteScopeKey(ctx, agentName) || ref.agentName !== agentName) {
        throw new Error(`Pending write contentRef ${refId} is not available in this session/agent.`);
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

export async function readResolvedPath(fullPath: string, displayPath: string, startLine?: number, endLine?: number, operations?: FileOperations, programmatic = false) {
    return readFileToolPath(fullPath, displayPath, startLine, endLine, operations, programmatic);
}

export async function writeResolvedPath(fullPath: string, content: string, overwrite: boolean, existsMessage: string | (() => string), options?: { createDirs?: boolean; parentIssueRetryHint?: (issue: WriteParentIssue) => string | undefined }, operations?: FileOperations) {
    await writeFileToolPath(fullPath, content, {
        overwrite,
        existsMessage,
        createDirs: options?.createDirs,
        parentIssueRetryHint: options?.parentIssueRetryHint,
    }, operations);
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

export async function editResolvedPath(fullPath: string, oldText: string, newText: string, operations: FileOperations = nativeFileOperations) {
    const content = (await readWholeFile(operations, fullPath)).toString('utf8');

    if (typeof oldText !== 'string' || typeof newText !== 'string') {
        throw new Error('Edit tool requires oldText and newText. Use apply_patch for patch-style edits.');
    }

    const updatedContent = applyExactReplacement(content, oldText, newText, 'oldText');
    await operations.write(fullPath, updatedContent, 'w');
}

export async function deleteResolvedPath(fullPath: string, displayPath: string) {
    const stats = await fs.lstat(fullPath);
    if (stats.isDirectory()) {
        throw new Error(`Cannot delete directory: ${displayPath}`);
    }

    await fs.remove(fullPath);
}

export function enforceIsolatedPathAccess(ctx: ToolContext | undefined, fullPath: string, agentName: string) {
    if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
        checkPathAccess(fullPath, agentName);
    }
}
