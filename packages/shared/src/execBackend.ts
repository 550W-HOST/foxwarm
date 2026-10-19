import type { FileOperations } from './fileOperations';
import type { ExecStatus, RunningExecEntry, StartPersistentExecOptions } from './persistentExec';

/** Core-owned adapter boundary. External providers receive only their public start/poll DTOs. */
export interface ExecBackend {
  readonly files: FileOperations;
  start(options: StartPersistentExecOptions & { execId: string }): Promise<RunningExecEntry>;
  poll(entry: RunningExecEntry): Promise<ExecStatus | null>;
  readFinishedWorkingDirectory(entry: RunningExecEntry): Promise<string | null>;
  readLiveWorkingDirectory(entry: RunningExecEntry): Promise<string | null>;
}

export interface ProviderExecReference {
  providerId: string;
  ref: string;
}

export interface ExecStarted {
  ref: string;
  outputPath: string;
  cwd: string;
  startedAt?: string;
  pid?: number;
}

export type ExecSnapshot =
  | { state: 'running'; cwd?: string }
  | { state: 'finished'; exitCode: number | null; finishedAt?: string; durationMs?: number; cwd?: string; error?: string }
  | { state: 'lost'; reason: string };
