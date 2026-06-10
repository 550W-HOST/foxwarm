import {
    ToolArgs,
    ToolContext,
    resolveAgentMemoryPath,
    normalizeMemoryRelativePath,
    readResolvedPath,
    writeResolvedPath,
    editResolvedPath,
    deleteResolvedPath,
    applyPatchOperations,
} from './helpers';

export async function tool_read_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath, startLine, endLine } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    return readResolvedPath(fullPath, relativePath, startLine, endLine);
}

export async function tool_write_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath, content } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    await writeResolvedPath(fullPath, content, false, `Memory file already exists: ${relativePath}. write_memory only creates new files; use edit_memory to modify an existing memory file.`, { createDirs: true });
    return `Memory file created: ${relativePath}`;
}

export async function tool_edit_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath, oldText, newText } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    await editResolvedPath(fullPath, oldText, newText);
    return `Memory file edited: ${relativePath}`;
}

export async function tool_delete_memory(args: ToolArgs, ctx: ToolContext) {
    const { filePath } = args;
    const agentName = ctx.session?.agent || 'main';
    const relativePath = normalizeMemoryRelativePath(filePath);
    const fullPath = resolveAgentMemoryPath(relativePath, agentName);
    await deleteResolvedPath(fullPath, relativePath);
    return `Deleted memory file \`${relativePath}\``;
}

export async function tool_apply_patch_memory(args: ToolArgs, ctx: ToolContext) {
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
