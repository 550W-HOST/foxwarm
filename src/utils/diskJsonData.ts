import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { promises as fsPromises } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export type DiskJsonDataBackupOptions = {
  rotate?: number;
  includeLegacyBak?: boolean;
  bestEffort?: boolean;
};

export type DiskJsonDataHooks<T> = {
  beforeWriteTemp?: (ctx: { filePath: string; tempPath: string; data: T; requestId: number }) => Promise<void> | void;
  beforeRename?: (ctx: { filePath: string; tempPath: string; data: T; requestId: number }) => Promise<void> | void;
  afterRename?: (ctx: { filePath: string; tempPath: string; data: T; requestId: number }) => Promise<void> | void;
};

export type DiskJsonDataOptions<T> = {
  spaces?: number;
  backup?: DiskJsonDataBackupOptions | false;
  normalizeLoadedData?: (raw: any, filePath: string) => T;
  onReadError?: (error: unknown, filePath: string) => void;
  onBackupError?: (error: unknown, filePath: string) => void;
  hooks?: DiskJsonDataHooks<T>;
};

type QueuedWrite<T> = {
  requestId: number;
  data: T;
  serialized: string;
};

type WriteWaiter = {
  requestId: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export function getNumberedBackupPath(filePath: string, index: number): string {
  return `${filePath}.${index}.bak`;
}

export function getLegacyBackupPath(filePath: string): string {
  return `${filePath}.bak`;
}

export function shouldIgnoreDirectorySyncError(error: any): boolean {
  return error?.code === 'EINVAL'
    || error?.code === 'ENOTSUP'
    || error?.code === 'ENOSYS'
    || error?.code === 'EPERM'
    || error?.code === 'EISDIR';
}

export async function syncDirectoryDurably(dirPath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    if (!shouldIgnoreDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function writeFileDurably(filePath: string, content: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsPromises.open(filePath, 'w');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

export class DiskJsonData<T> {
  readonly filePath: string;

  private readonly spaces: number;
  private readonly backup: DiskJsonDataBackupOptions;
  private readonly normalizeLoadedData: (raw: any, filePath: string) => T;
  private readonly onReadError?: (error: unknown, filePath: string) => void;
  private readonly onBackupError?: (error: unknown, filePath: string) => void;
  private readonly hooks?: DiskJsonDataHooks<T>;
  private pendingWrite: QueuedWrite<T> | null = null;
  private flushing = false;
  private nextRequestId = 0;
  private waiters: WriteWaiter[] = [];

  constructor(filePath: string, options: DiskJsonDataOptions<T> = {}) {
    this.filePath = filePath;
    this.spaces = options.spaces ?? 2;
    this.backup = options.backup === false
      ? { rotate: 0, includeLegacyBak: false, bestEffort: true }
      : {
        rotate: options.backup?.rotate ?? 0,
        includeLegacyBak: options.backup?.includeLegacyBak ?? false,
        bestEffort: options.backup?.bestEffort ?? true,
      };
    this.normalizeLoadedData = options.normalizeLoadedData || ((raw: any) => raw as T);
    this.onReadError = options.onReadError;
    this.onBackupError = options.onBackupError;
    this.hooks = options.hooks;
  }

  getBackupPaths(): string[] {
    const backups: string[] = [];
    for (let i = 1; i <= (this.backup.rotate || 0); i++) {
      backups.push(getNumberedBackupPath(this.filePath, i));
    }
    if (this.backup.includeLegacyBak) {
      backups.push(getLegacyBackupPath(this.filePath));
    }
    return backups;
  }

  listCandidatePaths(): string[] {
    return [this.filePath, ...this.getBackupPaths()];
  }

  async readFromPath(filePath: string = this.filePath): Promise<T | null> {
    if (!await fs.pathExists(filePath)) {
      return null;
    }

    try {
      const raw = await fs.readJson(filePath);
      return this.normalizeLoadedData(raw, filePath);
    } catch (error) {
      this.onReadError?.(error, filePath);
      throw error;
    }
  }

  async loadFirstAvailable(): Promise<{ data: T; source: string } | null> {
    for (const candidatePath of this.listCandidatePaths()) {
      try {
        const data = await this.readFromPath(candidatePath);
        if (data !== null) {
          return { data, source: candidatePath };
        }
      } catch {
        // readFromPath already forwarded to onReadError when configured
      }
    }

    return null;
  }

  write(data: T): Promise<void> {
    const requestId = ++this.nextRequestId;
    const serialized = JSON.stringify(data, null, this.spaces);

    this.pendingWrite = {
      requestId,
      data,
      serialized,
    };

    const writePromise = new Promise<void>((resolve, reject) => {
      this.waiters.push({ requestId, resolve, reject });
    });

    if (!this.flushing) {
      this.flushing = true;
      void this.flushLoop();
    }

    return writePromise;
  }

  private async flushLoop(): Promise<void> {
    while (this.pendingWrite) {
      const nextWrite = this.pendingWrite;
      this.pendingWrite = null;

      try {
        await this.writeSerialized(nextWrite);
        this.resolveWaitersUpTo(nextWrite.requestId);
      } catch (error) {
        this.rejectWaitersUpTo(nextWrite.requestId, error);
      }
    }

    this.flushing = false;
  }

  private resolveWaitersUpTo(requestId: number): void {
    const remaining: WriteWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.requestId <= requestId) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  private rejectWaitersUpTo(requestId: number, error: unknown): void {
    const remaining: WriteWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.requestId <= requestId) {
        waiter.reject(error);
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
  }

  private buildTempPath(): string {
    const tempId = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
    return path.join(path.dirname(this.filePath), `${path.basename(this.filePath)}.tmp-${tempId}`);
  }

  private async rotateBackupsIfNeeded(): Promise<void> {
    if (!await fs.pathExists(this.filePath)) {
      return;
    }

    const rotateCount = this.backup.rotate || 0;
    const run = async () => {
      if (rotateCount > 0) {
        for (let i = rotateCount; i >= 2; i--) {
          const prevPath = getNumberedBackupPath(this.filePath, i - 1);
          const nextPath = getNumberedBackupPath(this.filePath, i);
          if (await fs.pathExists(prevPath)) {
            await fs.move(prevPath, nextPath, { overwrite: true });
          }
        }
        await fs.copy(this.filePath, getNumberedBackupPath(this.filePath, 1), { overwrite: true });
      }

      if (this.backup.includeLegacyBak) {
        await fs.copy(this.filePath, getLegacyBackupPath(this.filePath), { overwrite: true });
      }
    };

    if (this.backup.bestEffort) {
      try {
        await run();
      } catch (error) {
        this.onBackupError?.(error, this.filePath);
      }
      return;
    }

    await run();
  }

  private async writeSerialized(queuedWrite: QueuedWrite<T>): Promise<void> {
    await fs.ensureDir(path.dirname(this.filePath));
    const tempPath = this.buildTempPath();

    try {
      await this.rotateBackupsIfNeeded();
      await this.hooks?.beforeWriteTemp?.({ filePath: this.filePath, tempPath, data: queuedWrite.data, requestId: queuedWrite.requestId });
      await writeFileDurably(tempPath, queuedWrite.serialized);
      await this.hooks?.beforeRename?.({ filePath: this.filePath, tempPath, data: queuedWrite.data, requestId: queuedWrite.requestId });
      await fsPromises.rename(tempPath, this.filePath);
      await syncDirectoryDurably(path.dirname(this.filePath));
      await this.hooks?.afterRename?.({ filePath: this.filePath, tempPath, data: queuedWrite.data, requestId: queuedWrite.requestId });
    } catch (error) {
      await fs.remove(tempPath).catch(() => {});
      throw error;
    }
  }
}
