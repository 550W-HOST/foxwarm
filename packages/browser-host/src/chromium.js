// Executable discovery for the managed headless browser. No browser is downloaded: the browser is
// whatever the operator installed. PUPPETEER_EXECUTABLE_PATH is the standard Puppeteer selector;
// otherwise common installed names are searched on PATH, then conventional install locations.
import fs from 'node:fs';
import path from 'node:path';

const NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
const WINDOWS_NAMES = ['chrome.exe', 'chromium.exe', 'msedge.exe'];
const FIXED = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/opt/homebrew/bin/chromium',
  '/usr/local/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Returns `{ path }` for the browser to launch, or `{ reason }` when none is usable. */
export function locateChromium(env = process.env) {
  const explicit = env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit) {
    return executable(explicit)
      ? { path: explicit }
      : { reason: 'PUPPETEER_EXECUTABLE_PATH does not name an executable file.' };
  }
  const names = process.platform === 'win32' ? WINDOWS_NAMES : NAMES;
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean))
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (executable(candidate)) return { path: candidate };
    }
  for (const candidate of FIXED) if (executable(candidate)) return { path: candidate };
  return {
    reason:
      'No Chromium or Chrome installation was found. Install one on this machine or set PUPPETEER_EXECUTABLE_PATH.',
  };
}
