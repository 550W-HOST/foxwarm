import path from 'node:path'

// Scenario files are children of run-app-e2e.mjs, never clients of an existing
// installation. Check this before reading a token, fetching, or launching Chrome.
export function appE2eRuntime() {
  const { FOXWARM_E2E_URL: baseUrl, FOXWARM_E2E_DATA_DIR: dataRoot, FOXWARM_E2E_TOKEN_FILE: tokenFile } = process.env
  if (process.env.FOXWARM_APP_E2E_OWNED !== '1' || !baseUrl || !dataRoot || !tokenFile
    || path.resolve(tokenFile) !== path.resolve(dataRoot, 'state/token')) {
    throw new Error('Run this scenario with test/app-e2e/run-app-e2e.mjs (FOXWARM_APP_E2E_FILES selects files); it requires an owned disposable application.')
  }
  return { baseUrl, dataRoot, tokenFile }
}
