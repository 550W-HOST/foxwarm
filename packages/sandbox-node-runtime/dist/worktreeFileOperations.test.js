"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const fs_extra_1 = __importDefault(require("fs-extra"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const worktreeFileOperations_1 = require("./worktreeFileOperations");
(0, node_test_1.default)('worktree file operations reject traversal and symlink escapes while allowing safe creation', async () => {
    const dir = await fs_extra_1.default.mkdtemp(node_path_1.default.join(node_os_1.default.tmpdir(), 'foxwarm-sandbox-runtime-'));
    const root = node_path_1.default.join(dir, 'worktree');
    const outside = node_path_1.default.join(dir, 'outside');
    await fs_extra_1.default.ensureDir(root);
    await fs_extra_1.default.ensureDir(outside);
    await fs_extra_1.default.writeFile(node_path_1.default.join(root, 'inside.txt'), 'inside');
    await fs_extra_1.default.writeFile(node_path_1.default.join(outside, 'secret.txt'), 'secret');
    await fs_extra_1.default.symlink(outside, node_path_1.default.join(root, 'escape'));
    const operations = (0, worktreeFileOperations_1.createWorktreeFileOperations)(root);
    try {
        strict_1.default.equal((await operations.read(node_path_1.default.join(root, 'inside.txt'), 0, 10)).toString(), 'inside');
        await operations.mkdir(node_path_1.default.join(root, 'new', 'nested'));
        await operations.write(node_path_1.default.join(root, 'new', 'nested', 'file.txt'), 'ok', 'wx');
        await strict_1.default.rejects(() => operations.read(node_path_1.default.join(root, '..', 'outside', 'secret.txt'), 0, 10), /outside/);
        await strict_1.default.rejects(() => operations.read(node_path_1.default.join(root, 'escape', 'secret.txt'), 0, 10), /symlink/);
        await strict_1.default.rejects(() => operations.write(node_path_1.default.join(root, 'escape', 'new.txt'), 'bad', 'w'), /symlink/);
        await fs_extra_1.default.symlink(node_path_1.default.join(root, 'inside.txt'), node_path_1.default.join(root, 'inside-link'));
        await strict_1.default.rejects(() => operations.read(node_path_1.default.join(root, 'inside-link'), 0, 10), /symlink/);
    }
    finally {
        await fs_extra_1.default.remove(dir);
    }
});
