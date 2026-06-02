import fs from 'fs-extra';
import path from 'path';
import { STATE_DIR } from './config';
import { logger } from './common';

export type WebUiSettings = {
  instanceName: string;
  tabIcon: string;
};

const WEBUI_SETTINGS_FILE_NAME = 'webui.json';

export function getWebUiSettingsPath(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, WEBUI_SETTINGS_FILE_NAME);
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

export function normalizeWebUiTabIcon(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error('tabIcon must be a string.');
  }

  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (Array.from(normalized).length > 16) {
    throw new Error('tabIcon must be at most 16 characters.');
  }

  return normalized;
}

export function readWebUiSettings(options: {
  settingsPath?: string;
} = {}): WebUiSettings {
  const settingsPath = options.settingsPath || getWebUiSettingsPath();

  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readJsonSync(settingsPath) as Partial<WebUiSettings>;
      return {
        instanceName: normalizeWebUiInstanceName(raw.instanceName || ''),
        tabIcon: normalizeWebUiTabIcon(raw.tabIcon || ''),
      };
    } catch (e: any) {
      logger.warn({ err: e, path: settingsPath }, 'Failed to read WebUI settings; using defaults');
      return { instanceName: '', tabIcon: '' };
    }
  }

  return { instanceName: '', tabIcon: '' };
}

export function writeWebUiSettings(settings: WebUiSettings, options: {
  settingsPath?: string;
} = {}): WebUiSettings {
  const settingsPath = options.settingsPath || getWebUiSettingsPath();
  const normalized: WebUiSettings = {
    instanceName: normalizeWebUiInstanceName(settings.instanceName),
    tabIcon: normalizeWebUiTabIcon(settings.tabIcon),
  };
  fs.ensureDirSync(path.dirname(settingsPath));
  fs.writeJsonSync(settingsPath, normalized, { spaces: 2 });
  return normalized;
}
