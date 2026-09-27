import fs from 'fs-extra';
import path from 'node:path';
import { open } from 'node:fs/promises';

export type FileOperationKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileOperationStat {
  kind: FileOperationKind;
  size: number;
  modifiedAtMs: number;
}

export interface FileOperationDirectoryEntry extends FileOperationStat {
  name: string;
}

/**
 * Low-level filesystem operations used by the shared model file tools.
 * Paths are already resolved by the caller; this interface owns no routing or
 * permission policy.
 */
export interface FileOperations {
  stat(filePath: string): Promise<FileOperationStat>;
  read(filePath: string, offset: number, count: number): Promise<Buffer>;
  readdir(dirPath: string): Promise<FileOperationDirectoryEntry[]>;
  write(filePath: string, content: string | Buffer, flag: 'w' | 'wx'): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  remove(filePath: string): Promise<void>;
}

function kindOf(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileOperationKind {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}

export function createNativeFileOperations(): FileOperations {
  return {
    async stat(filePath) {
      const stats = await fs.stat(filePath);
      return { kind: kindOf(stats), size: stats.size, modifiedAtMs: stats.mtimeMs };
    },

    async read(filePath, offset, count) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('File read offset must be a nonnegative safe integer.');
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('File read count must be a nonnegative safe integer.');
      if (count === 0) return Buffer.alloc(0);
      const file = await open(filePath, 'r');
      const output = Buffer.alloc(count);
      let total = 0;
      try {
        while (total < count) {
          const { bytesRead } = await file.read(output, total, count - total, offset + total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
      } finally {
        await file.close();
      }
      return output.subarray(0, total);
    },

    async readdir(dirPath) {
      const names = await fs.readdir(dirPath);
      const entries: FileOperationDirectoryEntry[] = [];
      for (const name of names) {
        const stats = await fs.lstat(path.join(dirPath, name));
        entries.push({ name, kind: kindOf(stats), size: stats.size, modifiedAtMs: stats.mtimeMs });
      }
      return entries;
    },

    async write(filePath, content, flag) {
      await fs.writeFile(filePath, content, { flag });
    },

    async mkdir(dirPath) {
      await fs.ensureDir(dirPath);
    },

    async remove(filePath) {
      await fs.remove(filePath);
    },
  };
}

export const nativeFileOperations: FileOperations = createNativeFileOperations();

export async function fileOperationPathExists(operations: FileOperations, filePath: string): Promise<boolean> {
  try {
    await operations.stat(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Read a complete file through bounded primitive requests. */
export async function readWholeFile(operations: FileOperations, filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const chunkSize = 64 * 1024;
  let offset = 0;
  while (true) {
    const chunk = await operations.read(filePath, offset, chunkSize);
    if (chunk.length === 0) break;
    chunks.push(chunk);
    offset += chunk.length;
    if (chunk.length < chunkSize) break;
  }
  return Buffer.concat(chunks);
}
