import {
  MODEL_EFFORTS,
  type ModelEffort,
  type ModelsConfig,
  loadModelsConfig,
} from '../config';
import type { Session } from '../types';

export type SessionModelEffortSettingsPatch = {
  model?: string | null;
  effort?: ModelEffort | null;
  childModelDefault?: string | null;
  childEffortDefault?: ModelEffort | null;
};

export type NormalizedSessionModelEffortSettings = {
  model?: string;
  effort?: ModelEffort;
  childModelDefault?: string;
  childEffortDefault?: ModelEffort;
};

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeStoredModel(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeExplicitModel(value: unknown, field: string): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a model key or null.`);
  return value.trim();
}

function normalizeEffort(value: unknown, field: string): ModelEffort | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !MODEL_EFFORTS.includes(value as ModelEffort)) {
    throw new Error(`${field} must be one of: ${MODEL_EFFORTS.join(', ')}, or null.`);
  }
  return value as ModelEffort;
}

function effectiveAllowedEfforts(modelsConfig: ModelsConfig, rawModel?: string): readonly ModelEffort[] {
  const key = rawModel && modelsConfig.models[rawModel] ? rawModel : modelsConfig.default;
  const entry = modelsConfig.models[key] || modelsConfig.models[modelsConfig.default];
  return entry?.effort?.allowed || MODEL_EFFORTS;
}

function normalizePair(options: {
  currentModel?: string;
  currentEffort?: ModelEffort;
  patch: { model?: string | null; effort?: ModelEffort | null };
  modelField: string;
  effortField: string;
  modelsConfig: ModelsConfig;
  fallbackModel?: string;
}): { model?: string; effort?: ModelEffort } {
  const { patch, modelField, effortField, modelsConfig } = options;
  const model = hasOwn(patch, 'model')
    ? normalizeExplicitModel(patch.model, modelField)
    : normalizeStoredModel(options.currentModel);
  const selectedModel = model || options.fallbackModel;
  const allowed = effectiveAllowedEfforts(modelsConfig, selectedModel);
  const requestedEffort = hasOwn(patch, 'effort')
    ? normalizeEffort(patch.effort, effortField)
    : normalizeEffort(options.currentEffort, effortField);
  if (hasOwn(patch, 'effort') && requestedEffort && !allowed.includes(requestedEffort)) {
    throw new Error(`${effortField} \`${requestedEffort}\` is not allowed by model \`${selectedModel || modelsConfig.default}\`.`);
  }
  return {
    ...(model ? { model } : {}),
    ...(requestedEffort && allowed.includes(requestedEffort) ? { effort: requestedEffort } : {}),
  };
}

/**
 * Normalize current and prospective-child model/effort pairs from one models
 * config snapshot. Explicit effort is strict; inherited/stored stale effort is
 * cleared when the prospective selected concrete model or virtual union no
 * longer allows it.
 */
export function normalizeProspectiveSessionModelEffortSettings(
  current: Pick<Session, 'model' | 'effort' | 'childModelDefault' | 'childEffortDefault'>,
  patch: SessionModelEffortSettingsPatch,
  modelsConfig: ModelsConfig = loadModelsConfig(),
): NormalizedSessionModelEffortSettings {
  const primary = normalizePair({
    currentModel: current.model,
    currentEffort: current.effort,
    patch: {
      ...(hasOwn(patch, 'model') ? { model: patch.model } : {}),
      ...(hasOwn(patch, 'effort') ? { effort: patch.effort } : {}),
    },
    modelField: 'model',
    effortField: 'effort',
    modelsConfig,
  });
  const child = normalizePair({
    currentModel: current.childModelDefault,
    currentEffort: current.childEffortDefault,
    patch: {
      ...(hasOwn(patch, 'childModelDefault') ? { model: patch.childModelDefault } : {}),
      ...(hasOwn(patch, 'childEffortDefault') ? { effort: patch.childEffortDefault } : {}),
    },
    modelField: 'childModelDefault',
    effortField: 'childEffortDefault',
    modelsConfig,
    fallbackModel: primary.model,
  });
  return {
    ...(primary.model ? { model: primary.model } : {}),
    ...(primary.effort ? { effort: primary.effort } : {}),
    ...(child.model ? { childModelDefault: child.model } : {}),
    ...(child.effort ? { childEffortDefault: child.effort } : {}),
  };
}

export function applyNormalizedSessionModelEffortSettings(
  session: Session,
  settings: NormalizedSessionModelEffortSettings,
): Array<keyof NormalizedSessionModelEffortSettings> {
  const changed: Array<keyof NormalizedSessionModelEffortSettings> = [];
  for (const key of ['model', 'effort', 'childModelDefault', 'childEffortDefault'] as const) {
    const previous = session[key];
    const next = settings[key];
    if (previous === next) continue;
    changed.push(key);
    if (next === undefined) delete session[key];
    else (session as any)[key] = next;
  }
  return changed;
}