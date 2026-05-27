import fs from 'fs-extra';
import path from 'path';
import { BASE_DIR, STATE_DIR } from './config';
import { logger } from './common';

export type WebUiSettings = {
  instanceName: string;
};

const WEBUI_SETTINGS_FILE_NAME = 'webui.json';

export function getWebUiSettingsPath(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, WEBUI_SETTINGS_FILE_NAME);
}

export function getLegacyWebUiSettingsPath(baseDir: string = BASE_DIR): string {
  return path.join(baseDir, 'state', WEBUI_SETTINGS_FILE_NAME);
}

function isSamePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

export function normalizeWebUiInstanceName(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error('instanceName must be a string.');
  }

  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (normalized.length > 80) {
    throw new Error('instanceName must be at most 80 characters.');
  }

  return normalized;
}

function readWebUiSettingsFromPath(filePath: string): WebUiSettings {
  const raw = fs.readJsonSync(filePath) as Partial<WebUiSettings>;
  return {
    instanceName: normalizeWebUiInstanceName(raw.instanceName || ''),
  };
}

export function readWebUiSettings(options: {
  settingsPath?: string;
  legacySettingsPath?: string;
} = {}): WebUiSettings {
  const settingsPath = options.settingsPath || getWebUiSettingsPath();
  const legacySettingsPath = options.legacySettingsPath || getLegacyWebUiSettingsPath();

  if (fs.existsSync(settingsPath)) {
    try {
      return readWebUiSettingsFromPath(settingsPath);
    } catch (e: any) {
      logger.warn({ err: e, path: settingsPath }, 'Failed to read WebUI settings; using defaults');
      return { instanceName: '' };
    }
  }

  if (!isSamePath(settingsPath, legacySettingsPath) && fs.existsSync(legacySettingsPath)) {
    try {
      const migrated = readWebUiSettingsFromPath(legacySettingsPath);
      fs.ensureDirSync(path.dirname(settingsPath));
      fs.writeJsonSync(settingsPath, migrated, { spaces: 2 });
      logger.info({ from: legacySettingsPath, to: settingsPath }, 'Migrated legacy WebUI settings to data state directory');
      return migrated;
    } catch (e: any) {
      logger.warn({ err: e, path: legacySettingsPath }, 'Failed to read legacy WebUI settings; using defaults');
      return { instanceName: '' };
    }
  }

  return { instanceName: '' };
}

export function writeWebUiSettings(settings: WebUiSettings, options: {
  settingsPath?: string;
} = {}): WebUiSettings {
  const settingsPath = options.settingsPath || getWebUiSettingsPath();
  const normalized: WebUiSettings = {
    instanceName: normalizeWebUiInstanceName(settings.instanceName),
  };
  fs.ensureDirSync(path.dirname(settingsPath));
  fs.writeJsonSync(settingsPath, normalized, { spaces: 2 });
  return normalized;
}
