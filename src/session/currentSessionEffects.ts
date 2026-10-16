import type { Message, Session, SessionStreamEvent } from '../types';
import type { ExecRuntime } from '../execManager';
import type { ActiveSessionRuntimeStateInput } from '../sessionRuntimeState';
import type { SessionWaitState, startSessionWaitForSession } from '../sessionManager';

/** In-process current-session effects used by the normal turn path. Not an RPC contract. */
export interface CurrentSessionEffects {
    placement: 'local' | 'session-worker';
    appendMessage(session: Session, message: Message): Promise<void>;
    persistSession(session: Session): Promise<void>;
    persistSessionStrict?(session: Session): Promise<void>;
    notifySessionEvent(sessionId: string, event: SessionStreamEvent): void;
    registerAbortController(sessionId: string, controller: AbortController): void;
    clearAbortController(sessionId: string, controller: AbortController): void;
    clearWaitById(sessionId: string | undefined, waitId: string): Promise<boolean>;
    execRuntime?: ExecRuntime;
}

export interface CurrentSessionTurnEffects extends CurrentSessionEffects {
    appendMessages(session: Session, messages: Message[]): Promise<void>;
    appendQueuedMessages(session: Session, messages: Message[]): Promise<void>;
    updateBusy(session: Session, busy: boolean): Promise<void>;
    startWait(session: Session, options?: Parameters<typeof startSessionWaitForSession>[1]): Promise<SessionWaitState>;
    notifyHistoryUpdate(sessionId: string, message: Message): void;
    setRuntimeState(sessionId: string, state: ActiveSessionRuntimeStateInput): void;
    clearRuntimeState(sessionId: string): void;
}

