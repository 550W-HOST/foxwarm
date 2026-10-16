import type { Session } from '../types';
import * as sessionManager from '../sessionManager';
import { getDefaultExecRuntime } from '../execManager';
import type { CurrentSessionTurnEffects } from './currentSessionEffects';

export function createDefaultCurrentSessionEffects(): CurrentSessionTurnEffects {
    const clearRuntimeState = (sessionId: string) => sessionManager.clearActiveSessionRuntimeState(sessionId);
    const persistSession = async (session: Session) => {
        if (session.id && sessionManager.getAllSessions().get(session.id) === session) {
            await sessionManager.saveSession(session);
        }
    };
    const persistSessionStrict = async (session: Session) => {
        if (session.id && sessionManager.getAllSessions().get(session.id) === session) {
            await sessionManager.saveSessionForSessionCritical(session);
        }
    };
    return {
        placement: 'local',
        appendMessage: (session, message) => sessionManager.appendSessionMessage(session, message),
        appendMessages: (session, messages) => sessionManager.appendSessionMessages(session, messages),
        appendQueuedMessages: (session, messages) => sessionManager.appendQueuedSessionMessages(session, messages),
        persistSession,
        persistSessionStrict,
        updateBusy: (session, busy) => {
            if (busy) sessionManager.assertSessionDestructiveMutationAllowed([session.id], 'start new work');
            return sessionManager.updateSessionBusyStateForSession(
                session, busy, () => persistSession(session), clearRuntimeState,
            );
        },
        startWait: (session, options) => sessionManager.startSessionWaitForSession(session, options, () => persistSession(session)),
        notifyHistoryUpdate: (sessionId, message) => sessionManager.notifyHistoryUpdate(sessionId, message),
        notifySessionEvent: (sessionId, event) => sessionManager.notifySessionEvent(sessionId, event),
        setRuntimeState: (sessionId, state) => sessionManager.setActiveSessionRuntimeState(sessionId, state),
        clearRuntimeState,
        registerAbortController: (sessionId, controller) => sessionManager.registerSessionAbortController(sessionId, controller),
        clearAbortController: (sessionId, controller) => sessionManager.clearSessionAbortController(sessionId, controller),
        clearWaitById: (sessionId, waitId) => sessionManager.clearSessionWaitById(sessionId, waitId),
        execRuntime: getDefaultExecRuntime(),
    };
}

