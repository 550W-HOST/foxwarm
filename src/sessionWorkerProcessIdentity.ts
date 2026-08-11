import fs from 'node:fs';
import { RpcError } from './rpc';

let bootId: string | undefined;

function readBootId(): string {
  if (!bootId) {
    bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!bootId) throw new Error('Linux boot ID is empty.');
  }
  return bootId;
}

export function readSessionWorkerProcessIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RpcError('SESSION_WORKER_INVALID_PID', 'Session worker PID must be a positive integer.');
  }
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
    throw new RpcError(
      'SESSION_WORKER_PROCESS_IDENTITY_UNAVAILABLE',
      `Cannot read process identity for PID ${pid}: ${error?.message || error}`,
      true,
    );
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) {
    throw new RpcError('SESSION_WORKER_PROCESS_IDENTITY_INVALID', `Process stat for PID ${pid} is malformed.`);
  }
  // Fields after the command begin at proc-stat field 3. Start time is field
  // 22, therefore index 19 in this suffix.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  if (!startTicks || !/^\d+$/.test(startTicks)) {
    throw new RpcError('SESSION_WORKER_PROCESS_IDENTITY_INVALID', `Process start time for PID ${pid} is unavailable.`);
  }
  return `${readBootId()}:${startTicks}`;
}

export function isExactSessionWorkerProcessAlive(pid: number, processIdentity: string): boolean {
  return readSessionWorkerProcessIdentity(pid) === processIdentity;
}
