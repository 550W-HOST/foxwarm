"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertWorktreePath = assertWorktreePath;
exports.createWorktreeFileOperations = createWorktreeFileOperations;
const fs_extra_1 = __importDefault(require("fs-extra"));
const node_path_1 = __importDefault(require("node:path"));
const fileOperations_1 = require("../../shared/dist/fileOperations");
function inside(root, candidate) {
    const relative = node_path_1.default.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${node_path_1.default.sep}`) && relative !== '..' && !node_path_1.default.isAbsolute(relative));
}
async function nearestExisting(candidate) {
    let current = candidate;
    while (true) {
        if (await fs_extra_1.default.pathExists(current))
            return current;
        const parent = node_path_1.default.dirname(current);
        if (parent === current)
            return current;
        current = parent;
    }
}
async function rejectSymlinkComponents(root, candidate) {
    const relative = node_path_1.default.relative(root, candidate);
    let current = root;
    for (const segment of relative.split(node_path_1.default.sep).filter(Boolean)) {
        current = node_path_1.default.join(current, segment);
        try {
            const stats = await fs_extra_1.default.lstat(current);
            if (stats.isSymbolicLink())
                throw new Error('Sandbox file path contains a symlink component.');
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                return;
            throw error;
        }
    }
}
async function assertWorktreePath(rootInput, candidateInput, existing) {
    const root = await fs_extra_1.default.realpath(node_path_1.default.resolve(rootInput));
    const candidate = node_path_1.default.resolve(candidateInput);
    if (!inside(root, candidate))
        throw new Error('Sandbox file path is outside the configured worktree.');
    await rejectSymlinkComponents(root, candidate);
    const anchor = existing ? candidate : await nearestExisting(candidate);
    let real;
    try {
        real = await fs_extra_1.default.realpath(anchor);
    }
    catch {
        throw new Error('Sandbox file path could not be resolved safely.');
    }
    if (!inside(root, real))
        throw new Error('Sandbox file path escapes the configured worktree through a symlink.');
    return candidate;
}
function createWorktreeFileOperations(root) {
    const native = (0, fileOperations_1.createNativeFileOperations)();
    return {
        async stat(filePath) { return native.stat(await assertWorktreePath(root, filePath, true)); },
        async read(filePath, offset, count) { return native.read(await assertWorktreePath(root, filePath, true), offset, count); },
        async readdir(filePath) { return native.readdir(await assertWorktreePath(root, filePath, true)); },
        async write(filePath, content, flag) {
            const exists = await fs_extra_1.default.pathExists(filePath);
            return native.write(await assertWorktreePath(root, filePath, exists), content, flag);
        },
        async mkdir(filePath) { return native.mkdir(await assertWorktreePath(root, filePath, false)); },
        async remove(filePath) { return native.remove(await assertWorktreePath(root, filePath, true)); },
    };
}
