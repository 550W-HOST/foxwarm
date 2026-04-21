import crypto from 'crypto';
import { QueueItem, Session } from '../types';

export type ManagedSessionState = {
  ownerSessionId: string;
  leaseId: string;
  controllerRunId?: string;
  revision: number;
  pendingInbox: QueueItem[];
  openedAt: number;
  leaseTouchedAt: number;
  lastStepAt?: number;
  lastInboxAt?: number;
  lastOwnerWakeupAt?: number;
  currentStep?: {
    stepId: string;
    runMode: 'idle' | 'tool';
  };
  lastStepResult?: {
    stepId: string;
    yieldReason: 'idle' | 'tool';
    yieldedAt: number;
  };
};

export const MANAGED_SESSION_LEASE_TTL_MS = 15 * 60 * 1000;

function isQueueItemLike(value: any): value is QueueItem {
  return !!value && typeof value === 'object' && typeof value.type === 'string';
}

export function cloneQueueItem(item: QueueItem): QueueItem {
  return structuredClone(item);
}

export function buildManagedSessionLeaseId(): string {
  return `msl_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function getManagedSessionState(session?: Session | null): ManagedSessionState | undefined {
  const raw = session?.meta?.managedSession;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const ownerSessionId = typeof raw.ownerSessionId === 'string' ? raw.ownerSessionId : '';
  const leaseId = typeof raw.leaseId === 'string' ? raw.leaseId : '';
  const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0;
  const pendingInbox = Array.isArray(raw.pendingInbox)
    ? raw.pendingInbox.filter(isQueueItemLike).map(cloneQueueItem)
    : [];

  if (!ownerSessionId || !leaseId || revision < 1) {
    return undefined;
  }

  return {
    ownerSessionId,
    leaseId,
    ...(typeof raw.controllerRunId === 'string' && raw.controllerRunId.trim() ? { controllerRunId: raw.controllerRunId.trim() } : {}),
    revision,
    pendingInbox,
    openedAt: typeof raw.openedAt === 'number' ? raw.openedAt : Date.now(),
    leaseTouchedAt: typeof raw.leaseTouchedAt === 'number' ? raw.leaseTouchedAt : (typeof raw.openedAt === 'number' ? raw.openedAt : Date.now()),
    ...(typeof raw.lastStepAt === 'number' ? { lastStepAt: raw.lastStepAt } : {}),
    ...(typeof raw.lastInboxAt === 'number' ? { lastInboxAt: raw.lastInboxAt } : {}),
    ...(typeof raw.lastOwnerWakeupAt === 'number' ? { lastOwnerWakeupAt: raw.lastOwnerWakeupAt } : {}),
    ...(raw.currentStep && typeof raw.currentStep === 'object' && typeof raw.currentStep.stepId === 'string' && (raw.currentStep.runMode === 'idle' || raw.currentStep.runMode === 'tool')
      ? {
          currentStep: {
            stepId: raw.currentStep.stepId,
            runMode: raw.currentStep.runMode,
          },
        }
      : {}),
    ...(raw.lastStepResult && typeof raw.lastStepResult === 'object' && typeof raw.lastStepResult.stepId === 'string' && (raw.lastStepResult.yieldReason === 'idle' || raw.lastStepResult.yieldReason === 'tool') && typeof raw.lastStepResult.yieldedAt === 'number'
      ? {
          lastStepResult: {
            stepId: raw.lastStepResult.stepId,
            yieldReason: raw.lastStepResult.yieldReason,
            yieldedAt: raw.lastStepResult.yieldedAt,
          },
        }
      : {}),
  };
}

export function setManagedSessionState(session: Session, state: ManagedSessionState | null): void {
  if (!session.meta) {
    session.meta = { lastMessageTime: Date.now() };
  }

  if (!state) {
    delete session.meta.managedSession;
    return;
  }

  session.meta.managedSession = {
    ownerSessionId: state.ownerSessionId,
    leaseId: state.leaseId,
    ...(state.controllerRunId ? { controllerRunId: state.controllerRunId } : {}),
    revision: state.revision,
    pendingInbox: state.pendingInbox.map(cloneQueueItem),
    openedAt: state.openedAt,
    leaseTouchedAt: state.leaseTouchedAt,
    ...(state.lastStepAt !== undefined ? { lastStepAt: state.lastStepAt } : {}),
    ...(state.lastInboxAt !== undefined ? { lastInboxAt: state.lastInboxAt } : {}),
    ...(state.lastOwnerWakeupAt !== undefined ? { lastOwnerWakeupAt: state.lastOwnerWakeupAt } : {}),
    ...(state.currentStep ? { currentStep: { ...state.currentStep } } : {}),
    ...(state.lastStepResult ? { lastStepResult: { ...state.lastStepResult } } : {}),
  };
}

export function isManagedSessionActive(session?: Session | null): boolean {
  return !!getManagedSessionState(session);
}

export function shouldRouteQueueItemToManagedInbox(session: Session | null | undefined, item: QueueItem): boolean {
  if (!isManagedSessionActive(session)) {
    return false;
  }

  return item.type !== 'compact' && item.type !== 'compact-commit';
}

export function getManagedSessionLastTouchedAt(state: ManagedSessionState): number {
  return Math.max(
    state.leaseTouchedAt || 0,
    state.lastStepAt || 0,
    state.lastInboxAt || 0,
    state.openedAt || 0,
  );
}

export function isManagedSessionLeaseExpired(state: ManagedSessionState, now = Date.now(), ttlMs = MANAGED_SESSION_LEASE_TTL_MS): boolean {
  return now - getManagedSessionLastTouchedAt(state) > ttlMs;
}
