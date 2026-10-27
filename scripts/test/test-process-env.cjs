const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let initialized;

// Called by test entry points, before importing application modules. A process-local
// guard lets the runner preload and the entry point share this initialization.
function initializeTestEnvironment() {
  if (initialized) return initialized;
  const runRoot = process.env.FOXWARM_TEST_RUN_ROOT;
  const parent = runRoot ? path.join(runRoot, 'processes') : os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const processRoot = fs.mkdtempSync(path.join(parent, 'fw-test-'));
  const dataRoot = path.join(processRoot, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  Object.assign(process.env, isolatedApplicationEnv(dataRoot));
  process.env.FOXWARM_TEST_PROCESS_ROOT = processRoot;
  process.env.FOXWARM_SYNC_FILE_LOG ??= '1';
  let tempRoot;
  if (process.env.FOXWARM_TEST_KEEP_SYSTEM_TMP !== '1') {
    const tempParent = process.env.FOXWARM_TEST_TEMP_ROOT || path.join(processRoot, 'tmp');
    fs.mkdirSync(tempParent, { recursive: true });
    tempRoot = fs.mkdtempSync(path.join(tempParent, 't-'));
    Object.assign(process.env, { TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot });
  }
  if (!runRoot) process.once('exit', () => {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(processRoot, { recursive: true, force: true });
  });
  initialized = { processRoot, dataRoot };
  return initialized;
}

// Do not carry installation path overrides into a fixture, including children
// whose explicit data root differs from the parent test's root.
function isolatedApplicationEnv(dataRoot, inherited = process.env) {
  const environment = { ...inherited };
  // Managed entry settings must not override the owned paths, ports or lifetime.
  for (const key of Object.keys(environment)) {
    if ([
      'FOXWARM_MAIN_LIFETIME_PIPE', 'FOXWARM_WINDOWS_CONTROL_PIPE',
      'FOXWARM_CLI_LIFETIME_PIPE', 'ASPNETCORE_URLS',
    ].includes(key)) delete environment[key];
  }
  return {
    ...environment,
    FOXWARM_DATA_DIR: dataRoot,
    FOXWARM_CONFIG_PATH: '', CONFIG_PATH: '', MCP_CONFIG_PATH: '',
    FOXWARM_AGENT_DIR: '', FOXWARM_AGENTS_DIR: path.join(dataRoot, 'agents'),
    WEB_SEARCH_MODELS_CONFIG_PATH: '',
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1,::1',
  };
}

module.exports = { initializeTestEnvironment, isolatedApplicationEnv };
