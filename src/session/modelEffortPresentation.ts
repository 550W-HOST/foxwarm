import { loadModelsConfig, MODEL_EFFORTS, type ModelEffort, type ModelsConfig } from '../config';
import type { Session } from '../types';

export type EffortPresentation = {
  raw: ModelEffort | null;
  effective: ModelEffort | 'default';
  allowed: ModelEffort[];
  defaultEffort: ModelEffort | null;
};

/**
 * Where the effective child model policy of a session comes from.
 * - `explicit`: the session pins a concrete child model (childModelDefault set).
 * - `follow-parent`: no pin; children follow the session's own resolved model.
 */
export type ChildModelPolicySource = 'explicit' | 'follow-parent';

/**
 * One hop of the child-model policy inheritance chain, ordered from the session
 * itself (`level: 'session'`) up through its ancestors (`level: 'inherited'`).
 * `supplies` marks the hop that supplied the effective child model; `source`
 * distinguishes a value introduced at that hop from one copied down by policy
 * propagation.
 */
export type ChildPolicyChainEntry = {
  level: 'session' | 'inherited';
  sessionId: string | null;
  modelKey: string | null;
  effort: ModelEffort | null;
  childModelDefault: string | null;
  childEffortDefault: ModelEffort | null;
  source: 'explicit' | 'inherited' | 'follow-parent';
  supplies: boolean;
};

/** Minimal session shape used to resolve a child-model policy chain hop. */
export type ModelEffortPolicySession = Pick<Session, 'model' | 'effort' | 'childModelDefault' | 'childEffortDefault'> & {
  id?: string;
  parentSessionId?: string;
};

/**
 * Synchronous, side-effect-free lookup used to walk a session's parent chain.
 * It may return `undefined` when an ancestor is not reachable; the chain then
 * degrades to the hops that could be resolved.
 */
export type ChildPolicyAncestryResolver = (sessionId: string) => ModelEffortPolicySession | undefined;

function modelEffortPresentation(modelsConfig: ModelsConfig, modelKey: string, raw?: ModelEffort | null, inherited?: ModelEffort | null): EffortPresentation {
  const entry = modelsConfig.models[modelKey];
  const allowed = [...(entry?.effort?.allowed || MODEL_EFFORTS)];
  const defaultEffort = entry?.virtualRouting ? null : (entry?.effort?.default || 'high');
  return {
    raw: raw || null,
    effective: (raw || inherited) && allowed.includes((raw || inherited)!) ? (raw || inherited)! : (defaultEffort || 'default'),
    allowed,
    defaultEffort,
  };
}

function rawModelKey(session?: Pick<Session, 'model'>): string | null {
  return typeof session?.model === 'string' && session.model.trim() ? session.model.trim() : null;
}

function rawChildModelKey(session?: Pick<Session, 'childModelDefault'>): string | null {
  return typeof session?.childModelDefault === 'string' && session.childModelDefault.trim()
    ? session.childModelDefault.trim()
    : null;
}

/**
 * Resolve the child-model policy chain for a session. The first entry is always
 * the session itself; further entries walk `parentSessionId` upward while the
 * resolver can supply each ancestor. Without a resolver (or when ancestry is not
 * reachable) the chain degrades to the single session hop.
 */
export function buildSessionChildPolicyChain(
  session: ModelEffortPolicySession,
  resolveAncestry?: ChildPolicyAncestryResolver,
): ChildPolicyChainEntry[] {
  const hops: ModelEffortPolicySession[] = [session];
  const seen = new Set<string>();
  if (typeof session.id === 'string' && session.id) seen.add(session.id);
  let cursorParentId = session.parentSessionId;
  while (resolveAncestry && cursorParentId && !seen.has(cursorParentId)) {
    seen.add(cursorParentId);
    const parent = resolveAncestry(cursorParentId);
    if (!parent) break;
    hops.push(parent);
    cursorParentId = parent.parentSessionId;
  }

  const effectiveRawChildModel = rawChildModelKey(session) || rawModelKey(session);
  // The supplier is the highest (root-most) hop that carries the effective
  // child model. Under top-down propagation the origin of a pinned policy is
  // the topmost hop with that value; without a pin the session's own model is
  // used, so the session hop supplies it.
  let supplierIndex = 0;
  if (effectiveRawChildModel !== null) {
    for (let index = 0; index < hops.length; index += 1) {
      if (rawChildModelKey(hops[index]) === effectiveRawChildModel) supplierIndex = index;
    }
  }

  return hops.map((hop, index): ChildPolicyChainEntry => {
    const hopChildModel = rawChildModelKey(hop);
    const parentHopChildModel = hops[index + 1] ? rawChildModelKey(hops[index + 1]) : null;
    const source: ChildPolicyChainEntry['source'] = hopChildModel === null
      ? 'follow-parent'
      : (index === hops.length - 1 || parentHopChildModel !== hopChildModel ? 'explicit' : 'inherited');
    return {
      level: index === 0 ? 'session' : 'inherited',
      sessionId: typeof hop.id === 'string' && hop.id ? hop.id : null,
      modelKey: rawModelKey(hop),
      effort: hop.effort ?? null,
      childModelDefault: hopChildModel,
      childEffortDefault: hop.childEffortDefault ?? null,
      source,
      supplies: index === supplierIndex,
    };
  });
}

export function buildSessionModelEffortPresentation(
  session: ModelEffortPolicySession,
  modelsConfig: ModelsConfig = loadModelsConfig(),
  resolveAncestry?: ChildPolicyAncestryResolver,
) {
  const defaultKey = modelsConfig.default;
  const rawModel = rawModelKey(session);
  const modelKey = rawModel && modelsConfig.models[rawModel] ? rawModel : defaultKey;
  const rawChildModel = rawChildModelKey(session);
  const inheritedChildModel = rawChildModel || rawModel;
  const effectiveChildModelKey = inheritedChildModel && modelsConfig.models[inheritedChildModel]
    ? inheritedChildModel
    : defaultKey;
  return {
    model: rawModel,
    modelKey,
    defaultModelKey: defaultKey,
    effort: modelEffortPresentation(modelsConfig, modelKey, session.effort),
    childModelDefault: rawChildModel,
    childModelPolicySource: (rawChildModel ? 'explicit' : 'follow-parent') as ChildModelPolicySource,
    effectiveChildModelKey,
    childEffort: modelEffortPresentation(modelsConfig, effectiveChildModelKey, session.childEffortDefault, session.effort),
    childPolicyChain: buildSessionChildPolicyChain(session, resolveAncestry),
  };
}
