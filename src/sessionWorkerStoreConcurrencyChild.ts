import { SessionWorkerStore } from './sessionWorkerStore';

const filePath = process.env.FOXWARM_TEST_STORE_PATH || '';
const action = JSON.parse(process.env.FOXWARM_TEST_STORE_ACTION || '{}');
let store: SessionWorkerStore | undefined;

process.on('message', (message: any) => {
  if (message?.kind === 'open') {
    try {
      store = new SessionWorkerStore(filePath); store.open(); process.send?.({ kind: 'opened' });
    } catch (error: any) {
      process.send?.({ kind: 'opened', error: error?.message || String(error) });
    }
    return;
  }
  if (message?.kind !== 'run' || !store) return;
  try {
    let result: unknown;
    if (action.type === 'enqueue') {
      result = store.enqueueIntent(action.sessionId, action.intentId, action.kind, action.payload);
    } else if (action.type === 'begin') {
      result = store.beginGeneration(action.sessionId, action.incarnationId);
    } else if (action.type === 'publish') {
      result = store.publishHead(action);
    } else {
      throw new Error(`Unknown action ${action.type}`);
    }
    process.send?.({ kind: 'result', value: { ok: true, result } });
  } catch (error: any) {
    process.send?.({ kind: 'result', value: { ok: false, code: error?.code, message: error?.message } });
  }
});
