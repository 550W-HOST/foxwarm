#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = __importDefault(require("fs-extra"));
const node_path_1 = __importDefault(require("node:path"));
const nodeTools_1 = require("../../shared/dist/nodeTools");
const applyPatch_1 = require("../../shared/dist/applyPatch");
const worktreeFileOperations_1 = require("./worktreeFileOperations");
function rejectParentSegments(value, label) {
    if (typeof value !== 'string')
        return;
    if (value.split(/[\\/]+/).includes('..'))
        throw new Error(`${label} must not contain parent-directory segments.`);
}
async function main() {
    const rootRaw = process.env.FOXWARM_WORKTREE_ROOT;
    if (!rootRaw)
        throw new Error('Sandbox runtime is missing FOXWARM_WORKTREE_ROOT.');
    const root = await fs_extra_1.default.realpath(node_path_1.default.resolve(rootRaw));
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!request || !request.args || typeof request.args !== 'object' || Array.isArray(request.args))
        throw new Error('Sandbox runtime request is invalid.');
    if (!['read', 'write', 'edit', 'apply_patch'].includes(request.toolName))
        throw new Error(`Unsupported sandbox capability: ${request.toolName}`);
    if (request.toolName === 'write' && Object.prototype.hasOwnProperty.call(request.args, 'contentRef')) {
        throw new Error('Sandbox Node write does not support contentRef; provide literal content instead.');
    }
    if (request.toolName === 'apply_patch') {
        if (typeof request.args.input !== 'string')
            throw new Error('apply_patch requires input string.');
        for (const operation of (0, applyPatch_1.parseApplyPatchInput)(request.args.input))
            rejectParentSegments(operation.filePath, 'Sandbox patch path');
    }
    else {
        rejectParentSegments(request.args.filePath, 'Sandbox file path');
    }
    rejectParentSegments(request.cwd, 'Sandbox session cwd');
    const cwd = typeof request.cwd === 'string' && request.cwd.trim() ? node_path_1.default.resolve(request.cwd) : root;
    const relative = node_path_1.default.relative(root, cwd);
    if (relative === '..' || relative.startsWith(`..${node_path_1.default.sep}`) || node_path_1.default.isAbsolute(relative))
        throw new Error('Sandbox session cwd is outside the configured worktree.');
    await (0, worktreeFileOperations_1.assertWorktreePath)(root, cwd, true);
    const ctx = { session: { agent: 'main', cwd }, fileOperations: (0, worktreeFileOperations_1.createWorktreeFileOperations)(root) };
    const tools = { read: nodeTools_1.read, write: nodeTools_1.write, edit: nodeTools_1.edit, apply_patch: nodeTools_1.apply_patch };
    const result = await tools[request.toolName](request.args, ctx);
    process.stdout.write(JSON.stringify({ ok: true, result }));
}
main().catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});
