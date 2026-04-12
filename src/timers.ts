import crypto from 'crypto';
import fs from 'fs-extra';
import schedule, { Job } from 'node-schedule';
import { TIMERS_FILE, getAgentDir } from './config';
import { logger } from './common';
import * as sessionManager from './sessionManager';
import { DiskJsonData } from './utils/diskJsonData';

export interface SessionTimer {
  id: string;
  sessionId: string;
  message: string;
  createdAt: number;
  newSession?: boolean;
  sessionPrefix?: string;
  agentName?: string;
  currentNode?: string;
  model?: string;
  at?: number;
  cron?: string;
  lastTriggeredAt?: number;
}

export interface TimerView extends SessionTimer {
  mode: 'once' | 'cron';
  nextRunAt: number | null;
}

const timers = new Map<string, SessionTimer>();
const jobs = new Map<string, Job>();
let initialized = false;

function normalizeTimersPayload(raw: any, filePath: string): { timers: any[] } {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid timers payload in ${filePath}`);
  }

  return {
    timers: Array.isArray(raw.timers) ? raw.timers : [],
  };
}

export function createTimersStore(filePath: string = TIMERS_FILE): DiskJsonData<{ timers: any[] }> {
  return new DiskJsonData<{ timers: any[] }>(filePath, {
    backup: {
      rotate: 2,
      includeLegacyBak: true,
      bestEffort: true,
    },
    normalizeLoadedData: normalizeTimersPayload,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read timers candidate');
    },
    onBackupError: (err: unknown) => {
      logger.warn({ err }, 'Failed to rotate timers backups');
    },
  });
}

let timersStore = createTimersStore();

export function setTimersStoreForTests(store: DiskJsonData<{ timers: any[] }> | null): void {
  timersStore = store || createTimersStore();
  cancelAllJobs();
  timers.clear();
  initialized = false;
}

export function resetTimersForTests(): void {
  cancelAllJobs();
  timers.clear();
  initialized = false;
}

function generateTimerId(): string {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeSessionPrefix(prefix?: string): string {
  const value = (prefix || 'timer').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error('sessionPrefix may only contain letters, numbers, hyphens, and underscores.');
  }
  return value;
}

function buildTriggeredSessionName(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
}

function isCronTimer(timer: SessionTimer): boolean {
  return typeof timer.cron === 'string' && timer.cron.trim().length > 0;
}

function getTimerMode(timer: SessionTimer): 'once' | 'cron' {
  return isCronTimer(timer) ? 'cron' : 'once';
}

function getNextRunAtFromJob(job?: Job): number | null {
  if (!job) return null;

  const nextInvocation = job.nextInvocation();
  if (!nextInvocation) return null;

  const maybeDate = typeof (nextInvocation as any).toDate === 'function'
    ? (nextInvocation as any).toDate()
    : nextInvocation;

  const ts = new Date(maybeDate as any).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function getNextRunAt(timer: SessionTimer): number | null {
  if (isCronTimer(timer)) {
    return getNextRunAtFromJob(jobs.get(timer.id));
  }

  if (typeof timer.at !== 'number') {
    return null;
  }

  return timer.at > Date.now() ? timer.at : null;
}

function toTimerView(timer: SessionTimer): TimerView {
  return {
    ...timer,
    mode: getTimerMode(timer),
    nextRunAt: getNextRunAt(timer),
  };
}

async function saveTimers(): Promise<void> {
  await timersStore.write({ timers: Array.from(timers.values()) });
}

function cancelTimerJob(timerId: string): void {
  const job = jobs.get(timerId);
  if (job) {
    job.cancel();
    jobs.delete(timerId);
  }
}

function cancelAllJobs(): void {
  for (const timerId of jobs.keys()) {
    cancelTimerJob(timerId);
  }
}

async function fireTimer(timerId: string): Promise<void> {
  const timer = timers.get(timerId);
  if (!timer) {
    return;
  }

  const label = isCronTimer(timer) ? 'Scheduled timer fired' : 'Timer fired';

  try {
    if (timer.newSession) {
      const ownerSession = await sessionManager.getExistingSession(timer.sessionId);
      const agentName = timer.agentName || ownerSession?.agent || 'main';
      if (!await fs.pathExists(getAgentDir(agentName))) {
        throw new Error(`Target agent "${agentName}" not found.`);
      }

      const sessionName = buildTriggeredSessionName(normalizeSessionPrefix(timer.sessionPrefix));
      const { sessionId } = await sessionManager.createSessionInAgent({
        agentName,
        sessionName,
        currentNode: timer.currentNode,
        model: timer.model,
      });

      await sessionManager.queueSessionSystemEvent(
        sessionId,
        `${label} (id: ${timer.id})\n${timer.message}`,
        'background'
      );
    } else {
      const targetSession = await sessionManager.getExistingSession(timer.sessionId);
      if (!targetSession) {
        throw new Error(`Target session "${timer.sessionId}" not found.`);
      }

      await sessionManager.queueSessionSystemEvent(
        timer.sessionId,
        `${label} (id: ${timer.id})\n${timer.message}`,
        'background'
      );
    }
  } catch (err) {
    logger.error({ err, timerId, sessionId: timer.sessionId }, 'Timer delivery failed');

    if (!isCronTimer(timer)) {
      cancelTimerJob(timer.id);
      timers.delete(timer.id);
      await saveTimers();
    }
    return;
  }

  timer.lastTriggeredAt = Date.now();

  if (isCronTimer(timer)) {
    await saveTimers();
    return;
  }

  cancelTimerJob(timer.id);
  timers.delete(timer.id);
  await saveTimers();
}

function scheduleTimer(timer: SessionTimer): void {
  cancelTimerJob(timer.id);

  if (isCronTimer(timer)) {
    const job = schedule.scheduleJob(timer.cron!, () => {
      void fireTimer(timer.id);
    });

    if (!job) {
      throw new Error(`Invalid cron expression: ${timer.cron}`);
    }

    jobs.set(timer.id, job);
    return;
  }

  if (typeof timer.at !== 'number') {
    throw new Error('One-time timer is missing `at`.');
  }

  if (timer.at <= Date.now()) {
    setImmediate(() => {
      void fireTimer(timer.id);
    });
    return;
  }

  const job = schedule.scheduleJob(new Date(timer.at), () => {
    void fireTimer(timer.id);
  });

  if (!job) {
    throw new Error(`Invalid timer date: ${timer.at}`);
  }

  jobs.set(timer.id, job);
}

function parseAbsoluteTime(at: unknown): number {
  if (typeof at === 'number') {
    return at;
  }

  if (typeof at === 'string' && at.trim()) {
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  throw new Error('`at` must be a valid absolute time (ISO string or epoch milliseconds).');
}

function normalizeCreateArgs(args: {
  at?: unknown;
  afterSeconds?: unknown;
  cron?: unknown;
  message?: unknown;
  newSession?: unknown;
  sessionPrefix?: unknown;
  agentName?: unknown;
  currentNode?: unknown;
  model?: unknown;
}) {
  const hasAt = args.at !== undefined && args.at !== null && args.at !== '';
  const rawAfter = args.afterSeconds;
  const hasRawAfter = rawAfter !== undefined && rawAfter !== null && rawAfter !== '';
  const parsedAfterSeconds = hasRawAfter ? Number(rawAfter) : undefined;
  const hasAfter = parsedAfterSeconds !== undefined && Number.isFinite(parsedAfterSeconds) && parsedAfterSeconds > 0;
  const hasCron = typeof args.cron === 'string' && args.cron.trim().length > 0;

  // Some tool-calling paths may inject placeholder values like afterSeconds=0
  // or at='' for omitted optional fields. Treat those placeholders as absent when
  // another real timer mode is present, but still validate them when they are the
  // only provided trigger field.
  if (!hasAfter && !hasAt && !hasCron && hasRawAfter) {
    throw new Error('`afterSeconds` must be a positive number.');
  }

  const specifiedCount = [hasAt, hasAfter, hasCron].filter(Boolean).length;
  if (specifiedCount !== 1) {
    throw new Error('Exactly one of `at`, `afterSeconds`, or `cron` is required.');
  }

  if (typeof args.message !== 'string' || !args.message.trim()) {
    throw new Error('`message` is required.');
  }

  let at: number | undefined;
  let cron: string | undefined;

  if (hasAt) {
    at = parseAbsoluteTime(args.at);
    if (at <= Date.now()) {
      throw new Error('`at` must be in the future.');
    }
  }

  if (hasAfter) {
    const afterSeconds = parsedAfterSeconds!;
    if (!Number.isFinite(afterSeconds) || afterSeconds <= 0) {
      throw new Error('`afterSeconds` must be a positive number.');
    }
    at = Date.now() + (afterSeconds * 1000);
  }

  if (hasCron) {
    cron = String(args.cron).trim();
  }

  return {
    at,
    cron,
    message: args.message.trim(),
    newSession: args.newSession === true,
    sessionPrefix: args.sessionPrefix === undefined ? undefined : normalizeSessionPrefix(String(args.sessionPrefix)),
    agentName: args.agentName === undefined || args.agentName === null || args.agentName === ''
      ? undefined
      : String(args.agentName).trim(),
    currentNode: args.currentNode === undefined || args.currentNode === null || args.currentNode === ''
      ? undefined
      : String(args.currentNode).trim(),
    model: args.model === undefined || args.model === null || args.model === ''
      ? undefined
      : String(args.model).trim(),
  };
}

function validatePersistedTimer(raw: any): SessionTimer | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  if (typeof raw.id !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.message !== 'string') {
    return null;
  }

  const timer: SessionTimer = {
    id: raw.id,
    sessionId: raw.sessionId,
    message: raw.message,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    newSession: raw.newSession === true,
    sessionPrefix: typeof raw.sessionPrefix === 'string' ? raw.sessionPrefix : undefined,
    agentName: typeof raw.agentName === 'string' ? raw.agentName : undefined,
    currentNode: typeof raw.currentNode === 'string' ? raw.currentNode : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    lastTriggeredAt: typeof raw.lastTriggeredAt === 'number' ? raw.lastTriggeredAt : undefined,
  };

  if (typeof raw.at === 'number') {
    timer.at = raw.at;
  }
  if (typeof raw.cron === 'string' && raw.cron.trim()) {
    timer.cron = raw.cron.trim();
  }

  const once = typeof timer.at === 'number';
  const cron = typeof timer.cron === 'string';
  if (once === cron) {
    return null;
  }

  return timer;
}

export async function initializeTimers(): Promise<void> {
  cancelAllJobs();
  timers.clear();

  const loaded = await timersStore.loadFirstAvailable();
  if (loaded) {
    try {
      const data = loaded.data;
      const rawTimers = Array.isArray(data?.timers) ? data.timers : [];
      for (const rawTimer of rawTimers) {
        const timer = validatePersistedTimer(rawTimer);
        if (!timer) {
          logger.warn({ rawTimer }, 'Skipping invalid persisted timer');
          continue;
        }
        timers.set(timer.id, timer);
      }
      if (loaded.source !== timersStore.filePath) {
        logger.warn({ source: loaded.source }, 'Recovering timers from fallback source');
        await timersStore.write({ timers: Array.from(timers.values()) });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load timers');
    }
  }

  for (const timer of timers.values()) {
    try {
      scheduleTimer(timer);
    } catch (err) {
      logger.error({ err, timerId: timer.id }, 'Failed to schedule persisted timer');
    }
  }

  initialized = true;
  logger.info({ timerCount: timers.size }, 'Timers initialized');
}

export async function createTimer(args: {
  sessionId: string;
  message: string;
  at?: unknown;
  afterSeconds?: unknown;
  cron?: unknown;
  newSession?: unknown;
  sessionPrefix?: unknown;
  agentName?: unknown;
  currentNode?: string;
  model?: string;
}): Promise<TimerView> {
  const targetSession = await sessionManager.getExistingSession(args.sessionId);
  if (!targetSession) {
    throw new Error(`Session \`${args.sessionId}\` not found.`);
  }

  await sessionManager.saveSession(args.sessionId);

  const normalized = normalizeCreateArgs(args);
  const agentName = normalized.newSession
    ? (normalized.agentName || targetSession.agent || 'main')
    : undefined;

  if (normalized.newSession && !await fs.pathExists(getAgentDir(agentName!))) {
    throw new Error(`Agent \`${agentName}\` not found.`);
  }

  const timer: SessionTimer = {
    id: generateTimerId(),
    sessionId: args.sessionId,
    message: normalized.message,
    createdAt: Date.now(),
    newSession: normalized.newSession,
    sessionPrefix: normalized.newSession ? (normalized.sessionPrefix || 'timer') : undefined,
    agentName,
    currentNode: normalized.newSession ? (args.currentNode || targetSession.currentNode) : undefined,
    model: normalized.newSession ? (args.model || targetSession.model) : undefined,
    at: normalized.at,
    cron: normalized.cron,
  };

  timers.set(timer.id, timer);
  try {
    scheduleTimer(timer);
    await saveTimers();
  } catch (err) {
    timers.delete(timer.id);
    cancelTimerJob(timer.id);
    throw err;
  }

  return toTimerView(timer);
}

export function listTimers(sessionId?: string): TimerView[] {
  return Array.from(timers.values())
    .filter(timer => !sessionId || timer.sessionId === sessionId)
    .map(toTimerView)
    .sort((a, b) => {
      const nextA = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      const nextB = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      if (nextA !== nextB) return nextA - nextB;
      return a.createdAt - b.createdAt;
    });
}

export async function deleteTimer(timerId: string, sessionId?: string): Promise<boolean> {
  const timer = timers.get(timerId);
  if (!timer) {
    return false;
  }

  if (sessionId && timer.sessionId !== sessionId) {
    throw new Error(`Timer \`${timerId}\` does not belong to session \`${sessionId}\`.`);
  }

  cancelTimerJob(timerId);
  timers.delete(timerId);
  await saveTimers();
  return true;
}

export function isTimersInitialized(): boolean {
  return initialized;
}
