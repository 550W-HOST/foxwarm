import { ProcessRpcServer, RpcServiceRegistry } from './rpc';
import { createSessionWorkerControlServiceHandler, sessionWorkerControlServiceDescriptor } from './sessionWorkerControlService';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { SessionWorkerStore } from './sessionWorkerStore';

const sessionId = process.env.FOXWARM_SESSION_WORKER_SESSION_ID || '';
const incarnationId = process.env.FOXWARM_SESSION_WORKER_INCARNATION_ID || '';
const storePath = process.env.FOXWARM_SESSION_WORKER_STORE_PATH || '';
const generation = Number(process.env.FOXWARM_SESSION_WORKER_GENERATION || 0);
const processIdentity = readSessionWorkerProcessIdentity(process.pid)!;
const store = new SessionWorkerStore(storePath);
const registry = new RpcServiceRegistry();
registry.register(sessionWorkerControlServiceDescriptor, createSessionWorkerControlServiceHandler(
  { sessionId, generation, incarnationId, pid: process.pid, processIdentity },
  () => { store.verifyActivatedIncarnation(sessionId, generation, incarnationId, process.pid, processIdentity); },
));
// Simulate cleanup that never resolves and a process that ignores graceful TERM.
// The startup reconciler must retain the fence until it escalates and observes
// this exact incarnation's real exit.
process.on('SIGTERM', () => {});
new ProcessRpcServer(registry, {
  generation,
  exitOnDrain: true,
  onDrain: () => new Promise<void>(() => {}),
  disconnectCleanupTimeoutMs: 10_000,
}).start();
