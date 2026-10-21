import type { ExecBackend, ExecSnapshot } from '../../packages/shared/dist/execBackend';
import type { FileOperations } from '../../packages/shared/dist/fileOperations';
import type { RunningExecEntry } from '../../packages/shared/dist/persistentExec';
import type { NodeProvider } from './providerRegistry';

/** Main-owned bridge from the public primitive protocol to the existing exec manager. */
export function createProviderExecBackend(provider: NodeProvider, nodeId: string, files: FileOperations): ExecBackend {
  return {
    files,
    async start(options) {
      if (options.externalOwner) throw new Error('Primitive exec does not support external owners.');
      const cwd = options.cwd ?? options.sessionCwd;
      if (cwd !== undefined && (typeof cwd !== 'string' || !cwd)) throw new Error('Exec cwd must be a non-empty string.');
      options.onBeforeProcessLaunch?.();
      const dispatchedAt = Date.now();
      let started;
      try {
        started = await provider.startExec!({ nodeId, command: options.command, ...(cwd === undefined ? {} : { cwd: cwd as string }) }, { signal: options.hardCancellationSignal });
      } catch (error) {
        // An adapter may already have submitted the command. Never retry this effect.
        throw new Error(`Exec start did not return a usable receipt; execution outcome is unknown. Do not automatically repeat the command. ${error instanceof Error ? error.message : 'Provider request failed.'}`);
      }
      options.onProcessStarted?.();
      return {
        id: options.execId,
        backend: { providerId: provider.id, ref: started.ref },
        ...(started.pid === undefined ? {} : { pid: started.pid }),
        sessionId: options.sessionId, agentName: options.agentName,
        nodeId, command: options.command, initialCwd: started.cwd,
        logPath: started.outputPath,
        startedAt: started.startedAt ? Date.parse(started.startedAt) : dispatchedAt,
        notifyOnCompletion: false,
      };
    },
    async poll(entry) {
      const snapshot: ExecSnapshot = await provider.pollExec!({ nodeId, ref: entry.backend!.ref });
      if ('cwd' in snapshot && snapshot.cwd !== undefined) entry.resolvedCwd = snapshot.cwd;
      if (snapshot.state === 'running') return null;
      if (snapshot.state === 'lost') return {
        exitCode: null, finishedAt: new Date().toISOString(), finishedAtIsEstimated: true,
        error: `Execution lost: ${snapshot.reason}`,
      };
      return {
        exitCode: snapshot.exitCode,
        finishedAt: snapshot.finishedAt || new Date().toISOString(),
        ...(snapshot.finishedAt ? {} : { finishedAtIsEstimated: true }),
        ...(snapshot.durationMs === undefined ? {} : { durationMs: snapshot.durationMs }),
        ...(snapshot.error ? { error: snapshot.error } : {}),
      };
    },
    async readFinishedWorkingDirectory(entry: RunningExecEntry) { return entry.resolvedCwd || null; },
    async readLiveWorkingDirectory(entry: RunningExecEntry) { return entry.resolvedCwd || null; },
  };
}
