import crypto from 'crypto';
import { QueueItem, Session } from '../types';

export type ManagedSessionState = {
  ownerSessionId: string;
  leaseId: string;
  revision: number;
  pendingInbox: QueueItem[];
  openedAt: number;
  lastStepAt?: number;
  lastInboxAt?: number;
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
    revision,
    pendingInbox,
    openedAt: typeof raw.openedAt === 'number' ? raw.openedAt : Date.now(),
    ...(typeof raw.lastStepAt === 'number' ? { lastStepAt: raw.lastStepAt } : {}),
    ...(typeof raw.lastInboxAt === 'number' ? { lastInboxAt: raw.lastInboxAt } : {}),
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
    revision: state.revision,
    pendingInbox: state.pendingInbox.map(cloneQueueItem),
    openedAt: state.openedAt,
    ...(state.lastStepAt !== undefined ? { lastStepAt: state.lastStepAt } : {}),
    ...(state.lastInboxAt !== undefined ? { lastInboxAt: state.lastInboxAt } : {}),
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
