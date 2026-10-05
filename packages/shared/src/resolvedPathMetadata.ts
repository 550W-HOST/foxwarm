export type ResolvedToolPath = { raw: string; resolved: string };

/** Private first-party Node-tool result carrier. Always removed before model/ToolScript output. */
export const RESOLVED_PATH_SIDECAR = '__foxwarmResolvedToolPaths';

export function withResolvedPathSidecar(result: unknown, paths: ResolvedToolPath[]): unknown {
  if (paths.length === 0) return result;
  const normalized = result && typeof result === 'object' && !Array.isArray(result)
    ? result : { output: result };
  return { ...normalized, [RESOLVED_PATH_SIDECAR]: paths };
}
