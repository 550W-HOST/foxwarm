import crypto from 'crypto';
import fs from 'fs-extra';
import schedule, { Job } from 'node-schedule';
import { TIMERS_FILE, getAgentDir } from './config';
import { logger } from './common';
import * as sessionManager from './sessionManager';
import type { Session } from './types';
import { DiskJsonData } from './utils/diskJsonData';
import { formatLocalTimestamp } from './utils/localTime';

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
  waitTimeoutId?: string;
  waitTimeoutSeconds?: number;
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
    backup: false,
    normalizeLoadedData: normalizeTimersPayload,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read timers candidate');
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

export function isCronTimer(timer: SessionTimer): boolean {
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

export function buildTimerTriggeredMessage(timer: SessionTimer, firedAt: Date = new Date()): string {
  const label = isCronTimer(timer) ? 'Scheduled timer fired' : 'Timer fired';
  const currentTimeLine = `Current time: ${formatLocalTimestamp(firedAt)}`;
  return timer.message
    ? `${label} (id: ${timer.id})\n${currentTimeLine}\n${timer.message}`
    : `${label} (id: ${timer.id})\n${currentTimeLine}`;
}

export function buildWaitTimeoutMessage(timer: Pick<SessionTimer, 'waitTimeoutSeconds'>): string {
  const seconds = typeof timer.waitTimeoutSeconds === 'number' && Number.isFinite(timer.waitTimeoutSeconds)
    ? timer.waitTimeoutSeconds
    : 0;
  return `[SYSTEM: wait timeout reached after ${seconds}s. No newer message or event triggered this session during the wait.]`;
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
  const firedAt = new Date();

  if (timer.waitTimeoutId) {
    try {
      const targetSession = await sessionManager.getExistingSession(timer.sessionId);
      if (!targetSession) {
        throw new Error(`Target session "${timer.sessionId}" not found.`);
      }

      await sessionManager.queueSessionWaitTimeoutEvent(
        timer.sessionId,
        timer.waitTimeoutId,
        buildWaitTimeoutMessage(timer),
      );
    } catch (err) {
      logger.error({ err, timerId, sessionId: timer.sessionId, waitTimeoutId: timer.waitTimeoutId }, 'Wait timeout delivery failed');
    } finally {
      cancelTimerJob(timer.id);
      timers.delete(timer.id);
      await saveTimers();
    }
    return;
  }

  const message = buildTimerTriggeredMessage(timer, firedAt);

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
        message,
        'background'
      );
    } else {
      const targetSession = await sessionManager.getExistingSession(timer.sessionId);
      if (!targetSession) {
        throw new Error(`Target session "${timer.sessionId}" not found.`);
      }

      await sessionManager.queueSessionSystemEvent(
        timer.sessionId,
        message,
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

  timer.lastTriggeredAt = firedAt.getTime();

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

function normalizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeTimerScheduleArgs(args: {
  at?: unknown;
  afterSeconds?: unknown;
  cron?: unknown;
}, options: { required: boolean }): { at?: number; cron?: string; scheduleProvided: boolean } {
  const hasAt = args.at !== undefined && args.at !== null && args.at !== '';
  const rawAfter = args.afterSeconds;
  const hasRawAfter = rawAfter !== undefined && rawAfter !== null && rawAfter !== '';
  const parsedAfterSeconds = hasRawAfter ? Number(rawAfter) : undefined;
  const hasAfter = parsedAfterSeconds !== undefined && Number.isFinite(parsedAfterSeconds) && parsedAfterSeconds > 0;
  const hasCron = typeof args.cron === 'string' && args.cron.trim().length > 0;

  // Some tool-calling paths may inject placeholder values like afterSeconds=0
  // or at='' for omitted optional fields. Treat those placeholders as absent when
  // another real timer mode is present, but still validate genuinely bad values.
  if (hasRawAfter && !hasAfter) {
    if (parsedAfterSeconds !== 0 || (options.required && !hasAt && !hasCron)) {
      throw new Error('`afterSeconds` must be a positive number.');
    }
  }

  const specifiedCount = [hasAt, hasAfter, hasCron].filter(Boolean).length;
  if (options.required && specifiedCount !== 1) {
    throw new Error('Exactly one of `at`, `afterSeconds`, or `cron` is required.');
  }
  if (!options.required && specifiedCount > 1) {
    throw new Error('At most one of `at`, `afterSeconds`, or `cron` may be updated at a time.');
  }

  if (specifiedCount === 0) {
    return { scheduleProvided: false };
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
    at = Date.now() + (afterSeconds * 1000);
  }

  if (hasCron) {
    cron = String(args.cron).trim();
  }

  return { at, cron, scheduleProvided: true };
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
  if (typeof args.message !== 'string' || !args.message.trim()) {
    throw new Error('`message` is required.');
  }

  const schedule = normalizeTimerScheduleArgs(args, { required: true });

  return {
    at: schedule.at,
    cron: schedule.cron,
    message: args.message.trim(),
    newSession: args.newSession === true,
    sessionPrefix: args.sessionPrefix === undefined ? undefined : normalizeSessionPrefix(String(args.sessionPrefix)),
    agentName: normalizeOptionalString(args.agentName),
    currentNode: normalizeOptionalString(args.currentNode),
    model: normalizeOptionalString(args.model),
  };
}

function normalizeTimerUpdate(existing: SessionTimer, ownerSession: Session | null, args: {
  message?: unknown;
  at?: unknown;
  afterSeconds?: unknown;
  cron?: unknown;
  newSession?: unknown;
  sessionPrefix?: unknown;
  agentName?: unknown;
  currentNode?: unknown;
  model?: unknown;
}): SessionTimer {
  const schedule = normalizeTimerScheduleArgs(args, { required: false });
  const hasMessageUpdate = hasOwn(args as Record<string, unknown>, 'message') && args.message !== undefined;
  const newSessionProvided = hasOwn(args as Record<string, unknown>, 'newSession')
    && args.newSession !== undefined
    && args.newSession !== null;
  const hasNewSessionFieldUpdate = ['sessionPrefix', 'agentName', 'currentNode', 'model']
    .some(key => normalizeOptionalString((args as Record<string, unknown>)[key]) !== undefined);

  if (!schedule.scheduleProvided && !hasMessageUpdate && !newSessionProvided && !hasNewSessionFieldUpdate) {
    throw new Error('At least one timer field must be supplied to update.');
  }

  const updated: SessionTimer = { ...existing };
  if (schedule.scheduleProvided) {
    updated.at = schedule.at;
    updated.cron = schedule.cron;
    // Changing a timer's schedule starts a fresh schedule window. For cron
    // timers, clear lastTriggeredAt so list/update summaries describe the new
    // recurrence rather than implying the old schedule just fired.
    updated.lastTriggeredAt = undefined;
  }

  if (hasMessageUpdate) {
    if (typeof args.message !== 'string' || !args.message.trim()) {
      throw new Error('`message` must be a non-empty string when supplied.');
    }
    updated.message = args.message.trim();
  }

  const finalNewSession = newSessionProvided ? args.newSession === true : existing.newSession === true;
  updated.newSession = finalNewSession;

  const newSessionOnlyFields = ['sessionPrefix', 'agentName', 'currentNode', 'model'];
  if (!finalNewSession) {
    const unexpected = newSessionOnlyFields.filter(key => normalizeOptionalString((args as Record<string, unknown>)[key]) !== undefined);
    if (unexpected.length > 0) {
      throw new Error(`${unexpected.join(', ')} may only be supplied when newSession=true.`);
    }
    updated.sessionPrefix = undefined;
    updated.agentName = undefined;
    updated.currentNode = undefined;
    updated.model = undefined;
    return updated;
  }

  const updatedSessionPrefix = normalizeOptionalString(args.sessionPrefix);
  updated.sessionPrefix = updatedSessionPrefix !== undefined
    ? normalizeSessionPrefix(updatedSessionPrefix)
    : (existing.sessionPrefix || 'timer');

  updated.agentName = normalizeOptionalString(args.agentName)
    || existing.agentName
    || ownerSession?.agent
    || 'main';
  updated.currentNode = normalizeOptionalString(args.currentNode)
    || existing.currentNode
    || ownerSession?.currentNode;
  updated.model = normalizeOptionalString(args.model)
    || existing.model
    || ownerSession?.model;

  return updated;
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
    waitTimeoutId: typeof raw.waitTimeoutId === 'string' ? raw.waitTimeoutId : undefined,
    waitTimeoutSeconds: typeof raw.waitTimeoutSeconds === 'number' ? raw.waitTimeoutSeconds : undefined,
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

export async function updateTimer(args: {
  timerId: string;
  sessionId?: string;
  message?: unknown;
  at?: unknown;
  afterSeconds?: unknown;
  cron?: unknown;
  newSession?: unknown;
  sessionPrefix?: unknown;
  agentName?: unknown;
  currentNode?: unknown;
  model?: unknown;
}): Promise<TimerView> {
  if (typeof args.timerId !== 'string' || !args.timerId.trim()) {
    throw new Error('timerId is required.');
  }

  const timerId = args.timerId.trim();
  const existing = timers.get(timerId);
  if (!existing || existing.waitTimeoutId) {
    throw new Error(`Timer \`${timerId}\` not found.`);
  }

  if (args.sessionId && existing.sessionId !== args.sessionId) {
    throw new Error(`Timer \`${timerId}\` does not belong to session \`${args.sessionId}\`.`);
  }

  const ownerSession = await sessionManager.getExistingSession(existing.sessionId);
  if (!ownerSession) {
    throw new Error(`Session \`${existing.sessionId}\` not found.`);
  }

  const updated = normalizeTimerUpdate(existing, ownerSession, args);
  if (updated.newSession) {
    const agentName = updated.agentName || ownerSession.agent || 'main';
    if (!await fs.pathExists(getAgentDir(agentName))) {
      throw new Error(`Agent \`${agentName}\` not found.`);
    }
  }

  timers.set(timerId, updated);
  try {
    scheduleTimer(updated);
    await saveTimers();
  } catch (err) {
    timers.set(timerId, existing);
    cancelTimerJob(timerId);
    scheduleTimer(existing);
    throw err;
  }

  return toTimerView(updated);
}

export async function createWaitTimeoutTimer(args: {
  sessionId: string;
  waitId: string;
  timeoutSeconds: number;
}): Promise<TimerView> {
  const targetSession = await sessionManager.getExistingSession(args.sessionId);
  if (!targetSession) {
    throw new Error(`Session \`${args.sessionId}\` not found.`);
  }

  if (typeof args.waitId !== 'string' || !args.waitId.trim()) {
    throw new Error('waitId is required.');
  }

  const timeoutSeconds = Number(args.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('timeoutSeconds must be a positive number.');
  }

  const timer: SessionTimer = {
    id: generateTimerId(),
    sessionId: args.sessionId,
    message: '',
    createdAt: Date.now(),
    at: Date.now() + (timeoutSeconds * 1000),
    waitTimeoutId: args.waitId,
    waitTimeoutSeconds: timeoutSeconds,
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
    .filter(timer => !timer.waitTimeoutId && (!sessionId || timer.sessionId === sessionId))
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
