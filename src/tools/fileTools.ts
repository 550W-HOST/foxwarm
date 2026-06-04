import {
    ToolArgs,
    ToolContext,
    resolveAgentPath,
    readResolvedPath,
    writeResolvedPath,
    editResolvedPath,
    deleteResolvedPath,
    applyPatchOperations,
    enforceIsolatedPathAccess,
    shouldEnforceIsolatedMasterPathAccess,
    deletePendingWriteRef,
    peekPendingWriteRefContent,
    registerPendingWriteRef,
    PENDING_WRITE_REF_TTL_MS,
} from './helpers';
import { checkPathAccess } from '../isolatedCheck';

export async function tool_read(args: ToolArgs, ctx: ToolContext) {
    const { filePath, startLine, endLine } = args;
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
    enforceIsolatedPathAccess(ctx, fullPath, agentName);
    return readResolvedPath(fullPath, filePath, startLine, endLine);
}

export async function tool_write(args: ToolArgs, ctx: ToolContext) {
    const { filePath, overwrite } = args;
    const createDirs = args.createDirs === true;
    const contentRef = typeof args.contentRef === 'string' ? args.contentRef.trim() : '';
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
    enforceIsolatedPathAccess(ctx, fullPath, agentName);

    if (contentRef) {
        if (typeof args.content === 'string') {
            throw new Error('write accepts either content or contentRef, not both.');
        }
        if (overwrite !== true) {
            throw new Error('write with contentRef requires overwrite=true.');
        }
        const content = peekPendingWriteRefContent(ctx, agentName, contentRef, fullPath);
        await writeResolvedPath(fullPath, content, true, `File already exists: ${filePath}.`, {
            createDirs,
            parentIssueRetryHint: (parentIssue) => parentIssue.reason === 'missing'
                ? ` Retry with filePath: ${JSON.stringify(filePath)}, overwrite: true, createDirs: true, contentRef: ${JSON.stringify(contentRef)} to reuse the cached content without resending it.`
                : undefined,
        });
        deletePendingWriteRef(contentRef);
        return 'File written successfully';
    }

    if (typeof args.content !== 'string') {
        throw new Error('write requires content, or contentRef with overwrite=true from a previous write attempt.');
    }

    const buildExistingFileError = () => {
        const pending = registerPendingWriteRef(ctx, agentName, fullPath, String(filePath), args.content);
        const retryHint = pending
            ? ` To overwrite using the same content without resending it, call write with filePath: ${JSON.stringify(filePath)}, overwrite: true, contentRef: ${JSON.stringify(pending.id)}. The contentRef expires in ${Math.floor(PENDING_WRITE_REF_TTL_MS / 60000)} minutes and only works in this session/agent for the same path.`
            : ` The attempted content was too large to cache for contentRef retry; call write again with content and overwrite=true if you want to replace it.`;
        return `File already exists: ${filePath}. Use overwrite=true to overwrite, or use edit tool to modify existing file.${retryHint}`;
    };

    await writeResolvedPath(fullPath, args.content, overwrite === true, buildExistingFileError, {
        createDirs,
        parentIssueRetryHint: (parentIssue) => {
            if (parentIssue.reason !== 'missing') {
                return undefined;
            }
            const pending = registerPendingWriteRef(ctx, agentName, fullPath, String(filePath), args.content);
            return pending
                ? ` To retry using the same content without resending it, call write with filePath: ${JSON.stringify(filePath)}, overwrite: true, createDirs: true, contentRef: ${JSON.stringify(pending.id)}. The contentRef expires in ${Math.floor(PENDING_WRITE_REF_TTL_MS / 60000)} minutes and only works in this session/agent for the same path.`
                : ` The attempted content was too large to cache for contentRef retry; call write again with content and createDirs=true if you want to create missing parent directories.`;
        },
    });
    return 'File written successfully';
}

export async function tool_edit(args: ToolArgs, ctx: ToolContext) {
    const { filePath, oldText, newText } = args;
    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
    enforceIsolatedPathAccess(ctx, fullPath, agentName);
    await editResolvedPath(fullPath, oldText, newText);
    return 'File edited successfully';
}

export async function tool_apply_patch(args: ToolArgs, ctx: ToolContext) {
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

export async function tool_delete_file(args: ToolArgs, ctx: ToolContext) {
    const { filePath } = args;
    if (!filePath || typeof filePath !== 'string') {
        throw new Error('filePath is required');
    }

    const agentName = ctx.session?.agent || 'main';
    const fullPath = resolveAgentPath(filePath, agentName, ctx.session?.cwd);
    enforceIsolatedPathAccess(ctx, fullPath, agentName);
    await deleteResolvedPath(fullPath, filePath);
    return `Deleted file \`${filePath}\``;
}
