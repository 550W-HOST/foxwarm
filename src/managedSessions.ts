import { Message, MessagePart, QueueItem } from './types';
import * as sessionManager from './sessionManager';
import { resolvePermittedSessionTarget } from './session/relations';
import {
  buildManagedSessionLeaseId,
  cloneQueueItem,
  getManagedSessionState,
  isManagedSessionLeaseExpired,
  ManagedSessionState,
  setManagedSessionState,
} from './session/managedState';

const activeManagedSteps = new Set<string>();

export type OpenManagedSessionResult = {
  sessionId: string;
  ownerSessionId: string;
  controllerRunId?: string;
  leaseId: string;
  revision: number;
  pendingInboxCount: number;
};

export type ManagedSessionStepResult = {
  sessionId: string;
  ownerSessionId: string;
  controllerRunId?: string;
  leaseId: string;
  revision: number;
  runMode: 'idle' | 'tool';
  inboxOrder: 'before' | 'after' | 'ignore';
  yieldReason: 'idle' | 'tool' | 'no-work';
  consumedPendingInboxCount: number;
  pendingInboxCount: number;
  queueLength: number;
  newMessages: Message[];
};

function buildManagedStepId(): string {
  return buildManagedSessionLeaseId().replace(/^msl_/, 'mss_');
}

function cloneQueueItems(items: QueueItem[]): QueueItem[] {
  return items.map(cloneQueueItem);
}

function requireOwnedManagedState(sessionId: string, state: ManagedSessionState | undefined, ownerSessionId: string, leaseId: string): ManagedSessionState {
  if (!state) {
    throw new Error(`Session \`${sessionId}\` is not under managed control.`);
  }
  if (state.ownerSessionId !== ownerSessionId) {
    throw new Error(`Session \`${sessionId}\` is managed by another owner session.`);
  }
  if (state.leaseId !== leaseId) {
    throw new Error(`Lease mismatch for managed session \`${sessionId}\`.`);
  }
  return state;
}

function prependQueueItems(sessionQueue: QueueItem[], items: QueueItem[]): QueueItem[] {
  if (items.length === 0) {
    return sessionQueue;
  }
  return [...cloneQueueItems(items), ...sessionQueue];
}

function buildManagerQueueItems(args: { parts?: MessagePart[] | null; message?: Message | null }): QueueItem[] {
  if (args.message) {
    return [{
      type: 'intersession',
      message: structuredClone(args.message),
    }];
  }

  if (args.parts?.length) {
    return [{
      type: 'intersession',
      parts: args.parts.map(part => ({ ...part })),
    }];
  }

  return [];
}

function getQueueItemsEligibleForManagedInbox(queue: QueueItem[]): { intercepted: QueueItem[]; retained: QueueItem[] } {
  const intercepted: QueueItem[] = [];
  const retained: QueueItem[] = [];

  for (const item of queue || []) {
    if (item.type === 'compact' || item.type === 'compact-commit') {
      retained.push(item);
      continue;
    }
    intercepted.push(cloneQueueItem(item));
  }

  return { intercepted, retained };
}

export function isManagedSessionBusyForStep(sessionId: string): boolean {
  return activeManagedSteps.has(sessionId);
}

export async function openManagedSession(args: { sessionId: string; ownerSessionId: string; controllerRunId?: string }): Promise<OpenManagedSessionResult> {
  const { targetSession: session } = await resolvePermittedSessionTarget({
    getExistingSession: sessionManager.getExistingSession,
    getAgentMetadata: sessionManager.getAgentMetadata,
  }, args.sessionId, args.ownerSessionId);
  if (session.id === args.ownerSessionId) {
    throw new Error('A session cannot manage itself. Create or use a child/linked session instead.');
  }
  const existing = getManagedSessionState(session);
  if (existing && !session.busy) {
    const existingOwner = await sessionManager.getExistingSession(existing.ownerSessionId);
    if (!existingOwner || isManagedSessionLeaseExpired(existing)) {
      session.queue = [...cloneQueueItems(existing.pendingInbox), ...(session.queue || [])];
      setManagedSessionState(session, null);
      await sessionManager.saveSession(session.id);
    }
  }
  const refreshedExisting = getManagedSessionState(session);
  if (refreshedExisting) {
    throw new Error(`Session \`${args.sessionId}\` is already under managed control.`);
  }
  if (session.busy) {
    throw new Error(`Session \`${args.sessionId}\` is busy and cannot be managed right now.`);
  }

  const { intercepted, retained } = getQueueItemsEligibleForManagedInbox(session.queue || []);
  session.queue = retained;

  const state: ManagedSessionState = {
    ownerSessionId: args.ownerSessionId,
    leaseId: buildManagedSessionLeaseId(),
    ...(args.controllerRunId ? { controllerRunId: args.controllerRunId } : {}),
    revision: 1,
    pendingInbox: intercepted,
    openedAt: Date.now(),
    leaseTouchedAt: Date.now(),
  };
  setManagedSessionState(session, state);
  await sessionManager.saveSession(session.id);

  return {
    sessionId: session.id,
    ownerSessionId: state.ownerSessionId,
    ...(state.controllerRunId ? { controllerRunId: state.controllerRunId } : {}),
    leaseId: state.leaseId,
    revision: state.revision,
    pendingInboxCount: state.pendingInbox.length,
  };
}

export async function managedSessionStep(args: {
  sessionId: string;
  ownerSessionId: string;
  controllerRunId?: string;
  leaseId: string;
  expectedRevision?: number;
  runMode?: 'idle' | 'tool';
  inboxOrder?: 'before' | 'after' | 'ignore';
  parts?: MessagePart[] | null;
  message?: Message | null;
}): Promise<ManagedSessionStepResult> {
  const { targetSession: session } = await resolvePermittedSessionTarget({
    getExistingSession: sessionManager.getExistingSession,
    getAgentMetadata: sessionManager.getAgentMetadata,
  }, args.sessionId, args.ownerSessionId);
  const managed = requireOwnedManagedState(args.sessionId, getManagedSessionState(session), args.ownerSessionId, args.leaseId);
  if (args.controllerRunId && managed.controllerRunId && managed.controllerRunId !== args.controllerRunId) {
    throw new Error(`Managed session \`${args.sessionId}\` is controlled by another ToolScript run.`);
  }
  const runMode = args.runMode || 'idle';
  const inboxOrder = args.inboxOrder || 'before';

  if (typeof args.expectedRevision === 'number' && managed.revision !== args.expectedRevision) {
    throw new Error(`Managed session revision mismatch for \`${args.sessionId}\`: expected ${args.expectedRevision}, got ${managed.revision}.`);
  }
  if (session.busy) {
    throw new Error(`Session \`${args.sessionId}\` is already busy.`);
  }
  if (activeManagedSteps.has(args.sessionId)) {
    throw new Error(`Managed step already in progress for session \`${args.sessionId}\`.`);
  }

  const queuedFromManager = buildManagerQueueItems({ parts: args.parts, message: args.message });
  const consumedPendingInbox = inboxOrder === 'ignore' ? [] : cloneQueueItems(managed.pendingInbox);
  const hasWork = consumedPendingInbox.length > 0 || queuedFromManager.length > 0 || session.queue.length > 0;
  const nextSeqStart = session.nextMessageSeq || 1;

  if (!hasWork) {
    return {
      sessionId: session.id,
      ownerSessionId: managed.ownerSessionId,
      ...(managed.controllerRunId ? { controllerRunId: managed.controllerRunId } : {}),
      leaseId: managed.leaseId,
      revision: managed.revision,
      runMode,
      inboxOrder,
      yieldReason: 'no-work',
      consumedPendingInboxCount: 0,
      pendingInboxCount: managed.pendingInbox.length,
      queueLength: session.queue.length,
      newMessages: [],
    };
  }

  if (inboxOrder !== 'ignore') {
    managed.pendingInbox = [];
  }
  managed.lastStepAt = Date.now();
  managed.leaseTouchedAt = managed.lastStepAt;
  managed.revision += 1;
  const stepId = buildManagedStepId();
  managed.currentStep = {
    stepId,
    runMode,
  };
  managed.lastStepResult = undefined;
  setManagedSessionState(session, managed);
  const stepQueueItems = inboxOrder === 'after'
    ? [...queuedFromManager, ...consumedPendingInbox]
    : [...consumedPendingInbox, ...queuedFromManager];
  session.queue = prependQueueItems(session.queue || [], stepQueueItems);
  await sessionManager.saveSession(session.id);

  activeManagedSteps.add(args.sessionId);
  let runnerError: any = null;
  try {
    await sessionManager.triggerSessionProcessing(session.id);
  } catch (error: any) {
    runnerError = error;
  } finally {
    activeManagedSteps.delete(args.sessionId);
  }

  const updated = await sessionManager.getSession(session.id);
  const updatedManaged = requireOwnedManagedState(args.sessionId, getManagedSessionState(updated), args.ownerSessionId, args.leaseId);
  const yieldReason = updatedManaged.lastStepResult?.stepId === stepId
    ? updatedManaged.lastStepResult.yieldReason
    : 'idle';
  updatedManaged.currentStep = undefined;
  updatedManaged.leaseTouchedAt = Date.now();
  setManagedSessionState(updated, updatedManaged);
  await sessionManager.saveSession(updated.id);

  if (runnerError) {
    throw runnerError;
  }

  return {
    sessionId: updated.id,
    ownerSessionId: updatedManaged.ownerSessionId,
    ...(updatedManaged.controllerRunId ? { controllerRunId: updatedManaged.controllerRunId } : {}),
    leaseId: updatedManaged.leaseId,
    revision: updatedManaged.revision,
    runMode,
    inboxOrder,
    yieldReason,
    consumedPendingInboxCount: consumedPendingInbox.length,
    pendingInboxCount: updatedManaged.pendingInbox.length,
    queueLength: updated.queue.length,
    newMessages: updated.history.filter((message) => (message.__meta?.seq || 0) >= nextSeqStart),
  };
}

export async function releaseManagedSession(args: {
  sessionId: string;
  ownerSessionId: string;
  controllerRunId?: string;
  leaseId: string;
  expectedRevision?: number;
}): Promise<{ sessionId: string; releasedPendingInboxCount: number }> {
  const { targetSession: session } = await resolvePermittedSessionTarget({
    getExistingSession: sessionManager.getExistingSession,
    getAgentMetadata: sessionManager.getAgentMetadata,
  }, args.sessionId, args.ownerSessionId);
  const managed = requireOwnedManagedState(args.sessionId, getManagedSessionState(session), args.ownerSessionId, args.leaseId);
  if (args.controllerRunId && managed.controllerRunId && managed.controllerRunId !== args.controllerRunId) {
    throw new Error(`Managed session \`${args.sessionId}\` is controlled by another ToolScript run.`);
  }

  if (typeof args.expectedRevision === 'number' && managed.revision !== args.expectedRevision) {
    throw new Error(`Managed session revision mismatch for \`${args.sessionId}\`: expected ${args.expectedRevision}, got ${managed.revision}.`);
  }
  if (session.busy || activeManagedSteps.has(args.sessionId)) {
    throw new Error(`Managed session \`${args.sessionId}\` is currently busy.`);
  }

  const pending = cloneQueueItems(managed.pendingInbox);
  setManagedSessionState(session, null);
  session.queue = prependQueueItems(session.queue || [], pending);
  await sessionManager.saveSession(session.id);

  if (!session.busy && session.queue.length > 0) {
    await sessionManager.triggerSessionProcessing(session.id);
  }

  return {
    sessionId: session.id,
    releasedPendingInboxCount: pending.length,
  };
}

export async function getManagedSessionStateForTests(sessionId: string): Promise<ManagedSessionState | undefined> {
  const session = await sessionManager.getSession(sessionId);
  return getManagedSessionState(session);
}
