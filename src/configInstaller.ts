import type { ChannelRuntimeStatus } from './channelRuntime';
import { isDeepStrictEqual } from 'node:util';
import { ACCESS_RUNTIME, APP_CONFIG, APP_CONFIG_PATH, TOKEN_FILE, getActiveModelsConfigPath, normalizePublicUrl, type AppConfig } from './config';
import { AccessConfigRuntime, hasAccessSurface, normalizeAccessConfig, assertAccessTokensDoNotMatch } from './accessConfig';
import { readRawTextFileIfExists, validateModelsConfigYaml, validateAppConfigYaml, writeRawAppConfig, writeRawModelsConfig } from './setupConfig';
import { installToolAuthorizationPolicyBytes, parseToolAuthorizationPolicyBytes } from './toolAuthorization';

export type ConfigTarget = 'config' | 'models' | 'tool-rules';
export type ConfigInstallResult = {
  saved: true;
  target: ConfigTarget;
  applied: string[];
  notApplied: string[];
  restartRequired: string[];
  reload?: { stopped: string[]; started: string[]; statuses: ChannelRuntimeStatus[] };
};

export class ConfigCandidateError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : 'Invalid YAML candidate.');
    this.name = 'ConfigCandidateError';
  }
}

function validateCandidate<T>(validate: () => T): T {
  try { return validate(); }
  catch (error) { throw new ConfigCandidateError(error); }
}

type ConfigInstallerOptions = {
  access: AccessConfigRuntime;
  startupConfig: AppConfig;
  appPath: string;
  modelsPath: () => string;
  instanceToken: () => string;
  reloadChannels: () => Promise<NonNullable<ConfigInstallResult['reload']>>;
};

/** One Main-owned install path for Setup and model tools, not a file watcher. */
export class ConfigInstaller {
  private tail: Promise<unknown> = Promise.resolve();
  private httpAvailable = false;
  constructor(private readonly options: ConfigInstallerOptions) {}

  setHttpAvailable(available: boolean): void { this.httpAvailable = available; }

  install(target: ConfigTarget, bytes: string | Buffer, authorize?: () => Promise<void>): Promise<ConfigInstallResult> {
    const job = this.tail.then(async () => { await authorize?.(); return this.installNow(target, bytes); });
    this.tail = job.catch(() => {});
    return job;
  }

  private async installNow(target: ConfigTarget, bytes: string | Buffer): Promise<ConfigInstallResult> {
    const result: ConfigInstallResult = { saved: true, target, applied: [], notApplied: [], restartRequired: [] };
    if (target === 'tool-rules') {
      validateCandidate(() => parseToolAuthorizationPolicyBytes(bytes));
      await installToolAuthorizationPolicyBytes(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      result.applied.push('tool-rules');
      return result;
    }
    const raw = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
    if (target === 'models') {
      validateCandidate(() => validateModelsConfigYaml(raw));
      writeRawModelsConfig(bytes, this.options.modelsPath());
      result.applied.push('models');
      return result;
    }
    if (target !== 'config') throw new Error('Unknown configuration target.');
    const config = validateCandidate(() => validateAppConfigYaml(raw));
    const access = normalizeAccessConfig(config.access);
    validateCandidate(() => {
      this.options.access.validate(access);
      assertAccessTokensDoNotMatch(access, this.options.instanceToken());
    });
    writeRawAppConfig(bytes, this.options.appPath);

    // Startup exports remain unchanged. Compare against startup, not the last save,
    // so an unapplied setting keeps its restart notice on subsequent saves.
    const keys = new Set([...Object.keys(this.options.startupConfig), ...Object.keys(config)]);
    for (const key of keys) {
      if (key === 'access' || key === 'channels') continue;
      const previous = key === 'url' ? normalizePublicUrl(this.options.startupConfig.url) : (this.options.startupConfig as any)[key];
      const next = key === 'url' ? normalizePublicUrl(config.url) : (config as any)[key];
      if (!isDeepStrictEqual(previous, next)) result.restartRequired.push(key);
    }
    if (!this.httpAvailable && hasAccessSurface(access, 'mcp')) result.restartRequired.push('access.surfaces.mcp');
    try {
      await this.options.access.apply(access);
      result.applied.push('access.identities');
    } catch {
      // The new snapshot is already published; do not claim the file was rolled back.
      result.applied.push('access.identities');
      result.notApplied.push('access.connections');
    }
    try {
      result.reload = await this.options.reloadChannels();
      if (result.reload.statuses.some(status => status.lastError)) result.notApplied.push('channels');
      else result.applied.push('channels');
    } catch {
      result.notApplied.push('channels');
    }
    return result;
  }
}

export const configInstaller = new ConfigInstaller({
  access: ACCESS_RUNTIME,
  startupConfig: APP_CONFIG,
  appPath: APP_CONFIG_PATH,
  modelsPath: getActiveModelsConfigPath,
  instanceToken: () => readRawTextFileIfExists(TOKEN_FILE).trim(),
  reloadChannels: async () => (await import('./channelRuntime')).reloadManagedChannels(),
});
