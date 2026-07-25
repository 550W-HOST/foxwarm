#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const yaml = require('js-yaml');

loadDotEnvIfPresent(path.resolve(__dirname, '../../.env'));

const SECRET_DIR = path.join(os.homedir(), '.secrets');

const OPENAI_SECRET_PATHS = {
  apiKey: [
    path.join(SECRET_DIR, 'web_search_openai_api_key'),
    path.join(SECRET_DIR, 'openai_api_key'),
  ],
  baseUrl: [
    path.join(SECRET_DIR, 'web_search_openai_base_url'),
    path.join(SECRET_DIR, 'openai_base_url'),
  ],
  model: [
    path.join(SECRET_DIR, 'web_search_openai_model'),
    path.join(SECRET_DIR, 'openai_web_search_model'),
  ],
};

const GEMINI_SECRET_PATHS = {
  apiKey: [
    path.join(SECRET_DIR, 'gemini_api_key'),
    path.join(SECRET_DIR, 'google_api_key'),
  ],
};

const DEFAULT_OPENAI_MODEL = 'gpt-5.5';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_WEB_SEARCH_TOOL = 'web_search';
const DEFAULT_OPENAI_TOOL_CHOICE = 'required';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_PROVIDER = 'auto';
const WEB_SEARCH_REQUEST_TIMEOUT_MS = 240000;
const BASE_DIR = path.resolve(__dirname, '../..');

const DEFAULT_SYSTEM_INSTRUCTION = [
  'You are being used as a recent-information lookup helper for another AI assistant.',
  'Your output will be consumed as external reference material, not shown as a casual end-user chat reply.',
  'For recent, current, latest, today, this week, this month, this year, version, release, pricing, policy, news, or other time-sensitive questions, use web search instead of relying only on parametric memory.',
  'Prioritize factual accuracy, recency, professional wording, clear structure, and key dates, versions, and qualifiers when relevant.',
  'Unless the user explicitly requests a different format, prefer this structure when appropriate: (1) a direct answer first, (2) a compact set of key supporting details, and (3) a short uncertainty/conflict note only if needed.',
  'When useful, anchor claims with concrete dates, version numbers, release stage, region, or other scope conditions so the downstream assistant can reason about them reliably.',
  'If search results are insufficient, ambiguous, or conflicting, say so briefly and explicitly.',
  'Do not include filler, self-referential AI disclaimers, or commentary about your internal process.',
  'Return only the answer content.',
].join(' ');

function loadDotEnvIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }

    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }

      const key = match[1];
      if (Object.prototype.hasOwnProperty.call(process.env, key)) {
        continue;
      }

      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // .env is optional; ignore parse/read failures and continue to explicit config.
  }
}

function firstEnv(names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return { value, source: name };
    }
  }
  return { value: '', source: '' };
}

function readFirstExistingSecret(paths) {
  for (const filePath of paths) {
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }

      const value = fs.readFileSync(filePath, 'utf8').trim();
      if (value) {
        return { value, source: filePath };
      }
    } catch {
      // Ignore secret file read errors here and continue to other sources.
    }
  }

  return { value: '', source: '' };
}

function firstConfig(envNames, secretPaths, fallbackValue = '') {
  const fromEnv = firstEnv(envNames);
  if (fromEnv.value) {
    return fromEnv;
  }

  const fromSecret = readFirstExistingSecret(secretPaths);
  if (fromSecret.value) {
    return fromSecret;
  }

  return { value: fallbackValue, source: fallbackValue ? 'default' : '' };
}

function loadOpenAIConfig(overrides = {}) {
  const apiKey = firstConfig(
    ['WEB_SEARCH_OPENAI_API_KEY', 'OPENAI_API_KEY'],
    OPENAI_SECRET_PATHS.apiKey,
  );
  const baseUrl = overrides.baseUrl
    ? { value: overrides.baseUrl, source: '--base-url' }
    : firstConfig(
      ['WEB_SEARCH_OPENAI_BASE_URL', 'OPENAI_BASE_URL'],
      OPENAI_SECRET_PATHS.baseUrl,
      DEFAULT_OPENAI_BASE_URL,
    );
  const model = overrides.model
    ? { value: overrides.model, source: '--model' }
    : firstConfig(
      ['WEB_SEARCH_OPENAI_MODEL', 'OPENAI_WEB_SEARCH_MODEL'],
      OPENAI_SECRET_PATHS.model,
      DEFAULT_OPENAI_MODEL,
    );
  const toolType = firstEnv(['WEB_SEARCH_OPENAI_TOOL_TYPE']).value || DEFAULT_OPENAI_WEB_SEARCH_TOOL;
  const toolChoice = overrides.toolChoice || firstEnv(['WEB_SEARCH_OPENAI_TOOL_CHOICE']).value || DEFAULT_OPENAI_TOOL_CHOICE;

  return {
    provider: 'openai',
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    baseUrl: baseUrl.value,
    baseUrlSource: baseUrl.source,
    model: model.value,
    modelSource: model.source,
    toolType,
    toolChoice,
  };
}

function loadGeminiConfig(overrides = {}) {
  const apiKey = firstConfig(
    ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    GEMINI_SECRET_PATHS.apiKey,
  );
  const model = overrides.model
    ? { value: overrides.model, source: '--model' }
    : firstConfig(
      ['WEB_SEARCH_GEMINI_MODEL', 'GEMINI_MODEL'],
      [],
      DEFAULT_GEMINI_MODEL,
    );

  return {
    provider: 'gemini',
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    model: model.value,
    modelSource: model.source,
  };
}

function expandUserPath(value) {
  if (!value) {
    return value;
  }
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveBaseRelativePath(value, baseDir = BASE_DIR) {
  const expanded = expandUserPath(String(value || '').trim());
  if (!expanded) {
    return '';
  }
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function readYamlFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  return yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
}

function getDataRootDir() {
  const envDataDir = process.env.FOXWARM_DATA_DIR?.trim();
  if (envDataDir) {
    return resolveBaseRelativePath(envDataDir);
  }

  const dataDirFile = path.join(BASE_DIR, 'data_dir');
  try {
    if (fs.existsSync(dataDirFile)) {
      const fileValue = fs.readFileSync(dataDirFile, 'utf8').trim();
      if (fileValue) {
        return resolveBaseRelativePath(fileValue);
      }
    }
  } catch {
    // Ignore data_dir read failures and fall back to BASE_DIR.
  }

  return BASE_DIR;
}

function resolveModelsConfigPath(explicitPath = '') {
  if (explicitPath?.trim()) {
    return resolveBaseRelativePath(explicitPath);
  }
  if (process.env.WEB_SEARCH_MODELS_CONFIG_PATH?.trim()) {
    return resolveBaseRelativePath(process.env.WEB_SEARCH_MODELS_CONFIG_PATH);
  }
  return path.join(getDataRootDir(), 'state', 'models.yaml');
}

function normalizeModelsField(providerEntry) {
  const rawModels = providerEntry?.models ?? providerEntry?.model;
  if (rawModels === undefined || rawModels === null || rawModels === '') {
    return [];
  }
  const list = Array.isArray(rawModels) ? rawModels : [rawModels];
  return list.map(item => {
    if (typeof item === 'string') {
      return item.trim();
    }
    if (item && typeof item === 'object' && typeof item.id === 'string') {
      return item.id.trim();
    }
    return '';
  }).filter(Boolean);
}

function providerTypeOf(providerEntry) {
  return String(providerEntry?.providerType || providerEntry?.provider || 'openai').trim();
}

function looksLikeGptModel(model) {
  return /^gpt[-_]?\d/i.test(model) || /^gpt-/i.test(model);
}

function hasUsableApiKey(value) {
  const key = String(value || '').trim();
  if (!key) {
    return false;
  }
  return !/^(your-|YOUR_|dummy-key$|changeme$|placeholder$|replace-me$)/i.test(key);
}

function compareGptModelIds(a, b) {
  const parse = value => {
    const match = String(value || '').match(/^gpt[-_]?([0-9]+(?:[.-][0-9]+)*)/i);
    const nums = match
      ? match[1].split(/[.-]/).map(part => Number.parseInt(part, 10)).filter(Number.isFinite)
      : [];
    return nums;
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) {
      return diff;
    }
  }

  // Prefer the plain model over suffix variants when the numeric version ties.
  const aHasSuffix = /^gpt[-_]?[0-9]+(?:[.-][0-9]+)*[-_]/i.test(a);
  const bHasSuffix = /^gpt[-_]?[0-9]+(?:[.-][0-9]+)*[-_]/i.test(b);
  if (aHasSuffix !== bHasSuffix) {
    return aHasSuffix ? -1 : 1;
  }
  return String(a).localeCompare(String(b));
}

function findGptModelCandidates(explicitModelsConfigPath = '') {
  const primaryPath = resolveModelsConfigPath(explicitModelsConfigPath);
  const fallbackPath = path.join(BASE_DIR, 'templates', 'models.example.yaml');
  const modelsConfigPath = fs.existsSync(primaryPath) ? primaryPath : fallbackPath;
  const config = readYamlFile(modelsConfigPath) || {};
  const providers = config.providers || config.models || {};
  const candidates = [];

  for (const [providerKey, providerEntry] of Object.entries(providers)) {
    const providerType = providerTypeOf(providerEntry);
    // Virtual providers contain references to concrete configured models, not
    // credentials or request endpoints of their own. Candidate discovery must
    // inspect only the concrete provider entries below.
    if (providerType === 'session-hash' || providerType === 'failover') {
      continue;
    }
    const models = normalizeModelsField(providerEntry);
    const baseUrl = String(providerEntry?.baseUrl || DEFAULT_OPENAI_BASE_URL).trim();
    const apiKey = String(providerEntry?.apiKey || '').trim();
    for (const model of models) {
      if (!looksLikeGptModel(model)) {
        continue;
      }
      candidates.push({
        providerKey,
        providerType,
        model,
        baseUrl,
        apiKey,
        hasApiKey: hasUsableApiKey(apiKey),
        sourcePath: modelsConfigPath,
        isFallbackTemplate: modelsConfigPath === fallbackPath && !fs.existsSync(primaryPath),
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.hasApiKey !== b.hasApiKey) {
      return a.hasApiKey ? -1 : 1;
    }
    const modelDiff = compareGptModelIds(b.model, a.model);
    if (modelDiff) {
      return modelDiff;
    }
    return `${a.providerKey}/${a.model}`.localeCompare(`${b.providerKey}/${b.model}`);
  });
}

function formatGptCandidates(candidates, maxItems = 12) {
  if (!candidates.length) {
    return '';
  }

  const shown = candidates.slice(0, maxItems).map(candidate => {
    const keyStatus = candidate.hasApiKey ? 'key present' : 'no usable key';
    return `  - ${candidate.providerKey}/${candidate.model} (${candidate.providerType}; baseUrl=${candidate.baseUrl || '(none)'}; ${keyStatus})`;
  });
  if (candidates.length > maxItems) {
    shown.push(`  ... ${candidates.length - maxItems} more`);
  }
  return shown.join('\n');
}

function chooseGptCandidate(candidates, options = {}) {
  let filtered = candidates;
  if (options.providerKey) {
    filtered = filtered.filter(candidate => candidate.providerKey === options.providerKey);
  }
  if (options.model) {
    filtered = filtered.filter(candidate => candidate.model === options.model);
  }
  return filtered.find(candidate => candidate.hasApiKey) || filtered[0] || null;
}

function ensureSecretDir() {
  fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(SECRET_DIR, 0o700);
  } catch {
    // Ignore chmod failures on platforms/filesystems that do not support POSIX modes.
  }
}

function writeSecretFile(filePath, value, force = false) {
  if (!force && fs.existsSync(filePath)) {
    return false;
  }
  fs.writeFileSync(filePath, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Ignore chmod failures on platforms/filesystems that do not support POSIX modes.
  }
  return true;
}

function initializeOpenAISecretsFromModelsConfig(options = {}) {
  const candidates = findGptModelCandidates(options.modelsConfigPath);
  const candidate = chooseGptCandidate(candidates, options);
  if (!candidate) {
    return {
      ok: false,
      message: `No GPT model candidates found in ${resolveModelsConfigPath(options.modelsConfigPath)}.`,
      candidates,
    };
  }
  if (!candidate.hasApiKey) {
    return {
      ok: false,
      message: `Candidate ${candidate.providerKey}/${candidate.model} does not have a usable apiKey in ${candidate.sourcePath}.`,
      candidates,
    };
  }

  ensureSecretDir();
  const written = [];
  const skipped = [];
  const writes = [
    [OPENAI_SECRET_PATHS.apiKey[0], candidate.apiKey, 'api key'],
    [OPENAI_SECRET_PATHS.model[0], candidate.model, 'model'],
    [OPENAI_SECRET_PATHS.baseUrl[0], candidate.baseUrl || DEFAULT_OPENAI_BASE_URL, 'base URL'],
  ];

  for (const [filePath, value, label] of writes) {
    if (writeSecretFile(filePath, value, options.force)) {
      written.push(`${label}: ${filePath}`);
    } else {
      skipped.push(`${label}: ${filePath}`);
    }
  }

  return {
    ok: true,
    candidate,
    candidates,
    written,
    skipped,
    message: [
      `Initialized web-search OpenAI config from ${candidate.sourcePath}.`,
      `Selected ${candidate.providerKey}/${candidate.model} (${candidate.providerType}); baseUrl=${candidate.baseUrl || DEFAULT_OPENAI_BASE_URL}.`,
      'API key value was copied but not printed.',
      written.length ? `Written: ${written.join(', ')}` : '',
      skipped.length ? `Skipped existing files (use --force to overwrite): ${skipped.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function loadOpenAIConfigFromModelsCandidate(candidate, overrides = {}) {
  if (!candidate?.hasApiKey) {
    return null;
  }
  return {
    provider: 'openai',
    apiKey: candidate.apiKey,
    apiKeySource: `${candidate.sourcePath} (${candidate.providerKey}; value hidden)`,
    baseUrl: overrides.baseUrl || candidate.baseUrl || DEFAULT_OPENAI_BASE_URL,
    baseUrlSource: overrides.baseUrl ? '--base-url' : `${candidate.sourcePath} (${candidate.providerKey})`,
    model: overrides.model || candidate.model,
    modelSource: overrides.model ? '--model' : `${candidate.sourcePath} (${candidate.providerKey})`,
    toolType: firstEnv(['WEB_SEARCH_OPENAI_TOOL_TYPE']).value || DEFAULT_OPENAI_WEB_SEARCH_TOOL,
    toolChoice: overrides.toolChoice || firstEnv(['WEB_SEARCH_OPENAI_TOOL_CHOICE']).value || DEFAULT_OPENAI_TOOL_CHOICE,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildMissingConfigGuidance(provider = 'auto', options = {}) {
  const wantsOpenAI = provider === 'auto' || provider === 'openai';
  const wantsGemini = provider === 'auto' || provider === 'gemini';
  const lines = [
    'web-search is not configured yet.',
    '',
    'Run the script first; if configuration is missing, use one of the setup options below and retry.',
  ];

  if (wantsOpenAI) {
    lines.push(
      '',
      'Preferred: OpenAI Responses API web search',
      '  export WEB_SEARCH_OPENAI_API_KEY="YOUR_OPENAI_API_KEY"',
      `  export WEB_SEARCH_OPENAI_MODEL="${DEFAULT_OPENAI_MODEL}"`,
      `  export WEB_SEARCH_OPENAI_BASE_URL="${DEFAULT_OPENAI_BASE_URL}"  # optional/custom gateway`,
      '',
      '  # or local secret files (not git-tracked):',
      '  mkdir -p ~/.secrets && chmod 700 ~/.secrets',
      '  printf \'%s\\n\' "YOUR_OPENAI_API_KEY" > ~/.secrets/web_search_openai_api_key',
      `  printf '%s\\n' "${DEFAULT_OPENAI_MODEL}" > ~/.secrets/web_search_openai_model`,
      `  printf '%s\\n' "${DEFAULT_OPENAI_BASE_URL}" > ~/.secrets/web_search_openai_base_url`,
      '  chmod 600 ~/.secrets/web_search_openai_*',
    );
  }

  if (wantsOpenAI) {
    const candidates = findGptModelCandidates(options.modelsConfigPath);
    const usableCandidates = candidates.filter(candidate => candidate.hasApiKey);
    if (candidates.length) {
      lines.push(
        '',
        `GPT candidates found in ${candidates[0].sourcePath} (API keys are not shown):`,
        formatGptCandidates(candidates),
      );
      if (usableCandidates.length) {
        const best = chooseGptCandidate(usableCandidates) || usableCandidates[0];
        lines.push(
          '',
          'To copy the latest usable GPT config into web-search secret files without printing the key:',
          `  node skills/web-search/web-search.js --init-from-models${options.modelsConfigPath ? ` --models-config ${shellQuote(resolveModelsConfigPath(options.modelsConfigPath))}` : ''}`,
          `  # default selection would be: ${best.providerKey}/${best.model}`,
        );
      }
    }
  }

  if (wantsGemini) {
    lines.push(
      '',
      'Fallback/legacy Gemini configuration (preserved from ask-gemini)',
      '  export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"',
      '  # or',
      '  export GOOGLE_API_KEY="YOUR_GEMINI_API_KEY"',
      '',
      '  # or local secret file:',
      '  mkdir -p ~/.secrets && chmod 700 ~/.secrets',
      '  printf \'%s\\n\' "YOUR_GEMINI_API_KEY" > ~/.secrets/gemini_api_key',
      '  chmod 600 ~/.secrets/gemini_api_key',
      '',
      `  # optional: export GEMINI_MODEL="${DEFAULT_GEMINI_MODEL}"`,
    );
  }

  lines.push(
    '',
    'Then retry:',
    '  node skills/web-search/web-search.js "What\'s the latest TypeScript stable version?"',
  );

  return lines.join('\n');
}

function printUsage() {
  console.error([
    'Usage: web-search.js [options] <question>',
    '',
    'Options:',
    '  --provider openai|gemini   Select provider (default: auto; OpenAI preferred)',
    '  --model MODEL              Override provider model for this run',
    '  --base-url URL             Override OpenAI-compatible base URL for this run',
    '  --tool-choice VALUE        OpenAI Responses tool_choice (default: required; use auto if desired)',
    '  --models-config PATH       Read GPT provider/model candidates from this Foxwarm models.yaml',
    '  --list-gpt-models          List GPT candidates from models.yaml without printing API keys',
    '  --init-from-models         Copy the latest usable GPT config from models.yaml into ~/.secrets',
    '  --provider-key KEY         Select a provider key for --init-from-models',
    '  --force                    Overwrite existing web-search secret files during initialization',
    '  --check-config             Show configured providers without making an API request',
    '  -h, --help                 Show this help',
    '',
    'Examples:',
    '  node skills/web-search/web-search.js "Summarize this week\'s major AI model releases"',
    '  echo "What\'s new in Node.js 24?" | node skills/web-search/web-search.js',
    '  node skills/web-search/web-search.js --check-config',
    '  node skills/web-search/web-search.js --init-from-models',
  ].join('\n'));
}

function parseArgs(argv) {
  const result = {
    provider: process.env.WEB_SEARCH_PROVIDER?.trim() || DEFAULT_PROVIDER,
    model: '',
    baseUrl: '',
    toolChoice: '',
    modelsConfigPath: '',
    providerKey: '',
    listGptModels: false,
    initFromModels: false,
    force: false,
    checkConfig: false,
    help: false,
    questionParts: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--check-config') {
      result.checkConfig = true;
    } else if (arg === '--provider') {
      result.provider = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--provider=')) {
      result.provider = arg.slice('--provider='.length);
    } else if (arg === '--model') {
      result.model = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--model=')) {
      result.model = arg.slice('--model='.length);
    } else if (arg === '--base-url') {
      result.baseUrl = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--base-url=')) {
      result.baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--tool-choice') {
      result.toolChoice = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--tool-choice=')) {
      result.toolChoice = arg.slice('--tool-choice='.length);
    } else if (arg === '--models-config') {
      result.modelsConfigPath = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--models-config=')) {
      result.modelsConfigPath = arg.slice('--models-config='.length);
    } else if (arg === '--provider-key') {
      result.providerKey = requireValue(argv, i, arg);
      i += 1;
    } else if (arg.startsWith('--provider-key=')) {
      result.providerKey = arg.slice('--provider-key='.length);
    } else if (arg === '--list-gpt-models') {
      result.listGptModels = true;
    } else if (arg === '--init-from-models') {
      result.initFromModels = true;
    } else if (arg === '--force') {
      result.force = true;
    } else {
      result.questionParts.push(arg);
    }
  }

  result.provider = result.provider.trim().toLowerCase();
  if (!['auto', 'openai', 'gemini'].includes(result.provider)) {
    throw new Error(`Invalid provider "${result.provider}". Use auto, openai, or gemini.`);
  }

  return result;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function chooseProvider(openai, gemini, requestedProvider) {
  if (requestedProvider === 'openai') {
    return openai.apiKey ? openai : null;
  }
  if (requestedProvider === 'gemini') {
    return gemini.apiKey ? gemini : null;
  }
  if (openai.apiKey) {
    return openai;
  }
  if (gemini.apiKey) {
    return gemini;
  }
  return null;
}

function printConfigCheck(openai, gemini, requestedProvider, modelsConfigPath = '') {
  const selected = chooseProvider(openai, gemini, requestedProvider);
  if (!selected) {
    console.error(buildMissingConfigGuidance(requestedProvider, { modelsConfigPath }));
    process.exit(2);
  }

  console.log(`web-search is configured. Default provider: ${selected.provider}.`);
  if (openai.apiKey) {
    console.log(`- openai: configured (${openai.apiKeySource}); model=${openai.model} (${openai.modelSource}); baseUrl=${openai.baseUrl} (${openai.baseUrlSource}); tool=${openai.toolType}; tool_choice=${openai.toolChoice}`);
  } else {
    console.log('- openai: not configured');
    const candidates = findGptModelCandidates(modelsConfigPath);
    if (candidates.length) {
      console.log(`  GPT candidates in ${candidates[0].sourcePath} (API keys hidden):`);
      console.log(formatGptCandidates(candidates));
    }
  }

  if (gemini.apiKey) {
    console.log(`- gemini: configured (${gemini.apiKeySource}); model=${gemini.model} (${gemini.modelSource})`);
  } else {
    console.log('- gemini: not configured');
  }
}

function normalizeOpenAIResponsesUrl(baseUrl) {
  const trimmed = (baseUrl || DEFAULT_OPENAI_BASE_URL).trim().replace(/\/+$/, '');
  if (/\/responses$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/responses`;
}

function extractOpenAIOutputText(responseData) {
  if (typeof responseData?.output_text === 'string' && responseData.output_text.trim()) {
    return responseData.output_text.trim();
  }

  const texts = [];
  const output = Array.isArray(responseData?.output) ? responseData.output : [];
  for (const item of output) {
    if (item?.type !== 'message') {
      continue;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string' && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
  }

  return texts.join('\n').trim();
}

function extractOpenAICitations(responseData) {
  const citations = [];
  const seen = new Set();
  const output = Array.isArray(responseData?.output) ? responseData.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const annotation of annotations) {
        if (annotation?.type !== 'url_citation' || !annotation.url) {
          continue;
        }
        if (seen.has(annotation.url)) {
          continue;
        }
        seen.add(annotation.url);
        citations.push({ title: annotation.title || annotation.url, url: annotation.url });
      }
    }
  }
  return citations;
}

function appendCitationsIfUseful(text, citations) {
  if (!citations.length) {
    return text;
  }

  const missingUrls = citations.filter(citation => !text.includes(citation.url));
  if (!missingUrls.length) {
    return text;
  }

  const sources = missingUrls.map(citation => `- ${citation.title} — ${citation.url}`).join('\n');
  return `${text}\n\nSources:\n${sources}`;
}

function extractGeminiText(responseData) {
  const candidates = Array.isArray(responseData?.candidates) ? responseData.candidates : [];
  const texts = [];

  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part?.text === 'string' && part.text.trim()) {
        texts.push(part.text);
      }
    }
  }

  return texts.join('\n').trim();
}

function readQuestionFromStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });
}

async function callOpenAI(config, question) {
  const tool = { type: config.toolType || DEFAULT_OPENAI_WEB_SEARCH_TOOL };
  const payload = {
    model: config.model,
    instructions: DEFAULT_SYSTEM_INSTRUCTION,
    tools: [tool],
    tool_choice: config.toolChoice || DEFAULT_OPENAI_TOOL_CHOICE,
    input: question,
  };

  const response = await axios.post(
    normalizeOpenAIResponsesUrl(config.baseUrl),
    payload,
    {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: WEB_SEARCH_REQUEST_TIMEOUT_MS,
    },
  );

  const text = extractOpenAIOutputText(response.data);
  if (!text) {
    throw new Error('OpenAI Responses API returned no text content.');
  }

  return appendCitationsIfUseful(text, extractOpenAICitations(response.data));
}

async function callGemini(config, question) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const response = await axios.post(
    url,
    {
      system_instruction: {
        parts: [
          {
            text: DEFAULT_SYSTEM_INSTRUCTION,
          },
        ],
      },
      contents: [
        {
          parts: [
            {
              text: question,
            },
          ],
        },
      ],
      tools: [
        {
          google_search: {},
        },
      ],
      generationConfig: {
        temperature: 0.2,
      },
    },
    {
      headers: {
        'x-goog-api-key': config.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: WEB_SEARCH_REQUEST_TIMEOUT_MS,
    },
  );

  const text = extractGeminiText(response.data);
  if (!text) {
    throw new Error('Gemini returned no text content.');
  }

  return text;
}

function formatProviderError(provider, error) {
  const status = error?.response?.status;
  const message = error?.response?.data?.error?.message
    || error?.response?.data?.message
    || error?.message
    || `Unknown ${provider} API error`;

  if (provider === 'openai') {
    if (status === 400 || status === 401 || status === 403) {
      return [
        `OpenAI Responses API ${status}: ${message}`,
        '',
        'Check that WEB_SEARCH_OPENAI_API_KEY (or OPENAI_API_KEY / ~/.secrets/web_search_openai_api_key) is valid,',
        'that WEB_SEARCH_OPENAI_BASE_URL points at an OpenAI-compatible /v1 base URL,',
        'and that the selected model supports the Responses API web_search tool.',
      ].join('\n');
    }
    return status ? `OpenAI Responses API ${status}: ${message}` : message;
  }

  if (status === 400 || status === 401 || status === 403) {
    return [
      `Gemini API ${status}: ${message}`,
      '',
      'Check that GEMINI_API_KEY / GOOGLE_API_KEY (or ~/.secrets/gemini_api_key) is valid and has Gemini API access.',
    ].join('\n');
  }
  return status ? `Gemini API ${status}: ${message}` : message;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    printUsage();
    process.exit(1);
  }

  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  if (parsed.listGptModels) {
    const candidates = findGptModelCandidates(parsed.modelsConfigPath);
    if (!candidates.length) {
      console.log(`No GPT model candidates found in ${resolveModelsConfigPath(parsed.modelsConfigPath)}.`);
      process.exit(1);
    }
    console.log(`GPT candidates in ${candidates[0].sourcePath} (API keys hidden):`);
    console.log(formatGptCandidates(candidates, 100));
    process.exit(0);
  }

  if (parsed.initFromModels) {
    const initResult = initializeOpenAISecretsFromModelsConfig({
      modelsConfigPath: parsed.modelsConfigPath,
      providerKey: parsed.providerKey,
      model: parsed.model,
      force: parsed.force,
    });
    if (!initResult.ok) {
      console.error(initResult.message);
      if (initResult.candidates?.length) {
        console.error('Available GPT candidates (API keys hidden):');
        console.error(formatGptCandidates(initResult.candidates, 100));
      }
      process.exit(2);
    }
    console.log(initResult.message);
    process.exit(0);
  }

  const providerOverrides = {
    model: parsed.model,
    baseUrl: parsed.baseUrl,
    toolChoice: parsed.toolChoice,
  };
  const openai = loadOpenAIConfig(providerOverrides);
  const gemini = loadGeminiConfig(providerOverrides);
  let effectiveOpenAI = openai;
  if (!openai.apiKey && parsed.provider !== 'gemini') {
    const candidate = chooseGptCandidate(findGptModelCandidates(parsed.modelsConfigPath), {
      providerKey: parsed.providerKey,
      model: parsed.model,
    });
    const candidateConfig = loadOpenAIConfigFromModelsCandidate(candidate, providerOverrides);
    if (candidateConfig) {
      effectiveOpenAI = candidateConfig;
    }
  }

  if (parsed.checkConfig) {
    printConfigCheck(effectiveOpenAI, gemini, parsed.provider, parsed.modelsConfigPath);
    process.exit(0);
  }

  const questionFromArgs = parsed.questionParts.join(' ').trim();
  const questionFromStdin = questionFromArgs ? '' : await readQuestionFromStdin();
  const question = questionFromArgs || questionFromStdin;

  if (!question) {
    printUsage();
    process.exit(1);
  }

  const selected = chooseProvider(effectiveOpenAI, gemini, parsed.provider);
  if (!selected) {
    console.error(buildMissingConfigGuidance(parsed.provider, { modelsConfigPath: parsed.modelsConfigPath }));
    process.exit(2);
  }

  try {
    const text = selected.provider === 'openai'
      ? await callOpenAI(selected, question)
      : await callGemini(selected, question);
    process.stdout.write(text);
  } catch (error) {
    console.error(formatProviderError(selected.provider, error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  findGptModelCandidates,
  chooseGptCandidate,
  WEB_SEARCH_REQUEST_TIMEOUT_MS,
};
