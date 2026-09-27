import fs from 'fs-extra';
import path from 'node:path';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';

async function run(): Promise<void> {
  const dbPath = process.env.FOXWARM_TEST_STORE_PATH || '';
  const markerPath = process.env.FOXWARM_TEST_MARKER_PATH || '';
  const store = new SessionWorkerStore(dbPath); store.open();
  const supervisor = new SessionWorkerSupervisor({
    store,
    idleMs: 60_000,
    workerScriptPath: path.join(__dirname, 'sessionWorkerHangingChild.js'),
  });
  await supervisor.reconcileStartupOwnerships();
  const status = await supervisor.ensureWorker('parent-crash-session');
  await fs.writeJson(markerPath, status);
  // Deliberately bypass supervisor shutdown to simulate a main-process crash.
  process.exit(77);
}

void run().catch(error => {
  console.error(error);
  process.exit(1);
});
