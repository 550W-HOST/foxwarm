import { loadModelsConfig, MODEL_EFFORTS, type ModelEffort, type ModelsConfig } from '../config';
import type { Session } from '../types';

export type EffortPresentation = {
  raw: ModelEffort | null;
  effective: ModelEffort | 'default';
  allowed: ModelEffort[];
  defaultEffort: ModelEffort | null;
};

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

export function buildSessionModelEffortPresentation(
  session: Pick<Session, 'model' | 'effort' | 'childModelDefault' | 'childEffortDefault'>,
  modelsConfig: ModelsConfig = loadModelsConfig(),
) {
  const defaultKey = modelsConfig.default;
  const rawModel = typeof session.model === 'string' && session.model.trim() ? session.model.trim() : null;
  const modelKey = rawModel && modelsConfig.models[rawModel] ? rawModel : defaultKey;
  const rawChildModel = typeof session.childModelDefault === 'string' && session.childModelDefault.trim()
    ? session.childModelDefault.trim()
    : null;
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
    effectiveChildModelKey,
    childEffort: modelEffortPresentation(modelsConfig, effectiveChildModelKey, session.childEffortDefault, session.effort),
  };
}
