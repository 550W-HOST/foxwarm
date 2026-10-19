import fs from 'fs-extra';
import path from 'node:path';
import { createExecRuntime } from '../execManager';
import { ExecutableNodeProvider } from './executableProvider';
import { NodeProviderRegistry } from './providerRegistry';

// A real short-lived Core process used to prove persisted handles survive process exit.
async function main() {
  const [mode, configPath, registryPath, resultPath] = process.argv.slice(2);
  const config = await fs.readJson(configPath);
  const completions: unknown[] = [];
  const provider = new ExecutableNodeProvider(config.provider);
  const runtime = createExecRuntime({ getDefaultCwd: () => path.dirname(registryPath), getExecTempDir: () => path.dirname(registryPath), registryPath,
    resolveBackend: (providerId, nodeId) => registry.execBackend(providerId, nodeId),
    completionDispatcher: async (entry, status, message) => { completions.push({ sessionId: entry.sessionId, execId: entry.id, status, message }); },
  });
  const registry = new NodeProviderRegistry([provider], { getExecRuntime: () => runtime });
  try {
    await runtime.initialize();
    if (mode === 'start') {
      const entry = await runtime.startPersistentExec({ backend: { providerId: provider.id }, nodeId: config.nodeId,
        command: config.command, sessionId: 'restart-owner', agentName: 'main' });
      await runtime.markExecForBackgroundNotification(entry.id);
      await fs.writeJson(resultPath, { entry });
    } else {
      const entry = runtime.listRunningExecs()[0];
      if (entry) await runtime.waitForExecCompletion(entry.id, 5000);
      await runtime.reconcileNow();
      await fs.writeJson(resultPath, { completions, remaining: runtime.listRunningExecs() });
    }
  } finally { await runtime.shutdown(); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
