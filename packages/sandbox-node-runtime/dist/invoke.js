#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_extra_1 = __importDefault(require("fs-extra"));
const node_path_1 = __importDefault(require("node:path"));
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
    if (!request || typeof request.path !== 'string' || !['parent', 'stat', 'read', 'readdir', 'write', 'mkdir', 'remove'].includes(request.operation)) {
        throw new Error('Sandbox runtime request is invalid.');
    }
    rejectParentSegments(request.path, 'Sandbox file path');
    rejectParentSegments(request.cwd, 'Sandbox session cwd');
    const cwd = typeof request.cwd === 'string' && request.cwd.trim() ? node_path_1.default.resolve(request.cwd) : root;
    const relative = node_path_1.default.relative(root, cwd);
    if (relative === '..' || relative.startsWith(`..${node_path_1.default.sep}`) || node_path_1.default.isAbsolute(relative))
        throw new Error('Sandbox session cwd is outside the configured worktree.');
    const target = node_path_1.default.isAbsolute(request.path) ? request.path : node_path_1.default.resolve(cwd, request.path);
    const operations = (0, worktreeFileOperations_1.createWorktreeFileOperations)(root);
    let result;
    if (request.operation === 'parent')
        result = { path: node_path_1.default.dirname(target) };
    else if (request.operation === 'stat')
        result = await operations.stat(target);
    else if (request.operation === 'read') {
        if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(request.count) || request.count < 0)
            throw new Error('Sandbox read offset/count are invalid.');
        result = { dataBase64: (await operations.read(target, request.offset, request.count)).toString('base64') };
    }
    else if (request.operation === 'readdir')
        result = await operations.readdir(target);
    else if (request.operation === 'write') {
        if (typeof request.contentBase64 !== 'string' || !['w', 'wx'].includes(request.flag || ''))
            throw new Error('Sandbox write request is invalid.');
        await operations.write(target, Buffer.from(request.contentBase64, 'base64'), request.flag);
        result = null;
    }
    else if (request.operation === 'mkdir') {
        await operations.mkdir(target);
        result = null;
    }
    else {
        await operations.remove(target);
        result = null;
    }
    process.stdout.write(JSON.stringify({ ok: true, result }));
}
main().catch(error => {
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'SANDBOX_FILESYSTEM_ERROR';
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }));
});
