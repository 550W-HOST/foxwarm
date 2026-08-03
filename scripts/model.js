#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class CliUsageError extends Error {}

function requireValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new CliUsageError(`${option} requires a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    model: undefined,
    prompt: undefined,
    system: '',
    list: false,
    json: false,
    help: false,
    timeoutMs: 300_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model' || arg === '-m') {
      args.model = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--prompt' || arg === '-p') {
      args.prompt = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--system' || arg === '-s') {
      args.system = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === '--timeout' || arg === '-t') {
      const rawValue = requireValue(argv, index, arg);
      const seconds = Number(rawValue);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new CliUsageError(`${arg} must be a positive number of seconds.`);
      }
      args.timeoutMs = Math.round(seconds * 1000);
      index += 1;
    } else if (arg === '--list' || arg === '-l' || arg === '--list-models') {
      args.list = true;
    } else if (arg === '--json' || arg === '-j') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new CliUsageError(`Unknown option or argument: ${arg}`);
    }
  }

  return args;
}

function printHelp(stream) {
  stream.write(`foxwarm model — send one prompt through Foxwarm's configured production model stack

Usage:
  echo "your prompt" | foxwarm model --model <model-key>
  foxwarm model --model <model-key> --prompt "your prompt"
  foxwarm model --list

Options:
  -m, --model <key>      Model key from models.yaml (defaults to configured default)
  -p, --prompt <text>    Prompt text (otherwise read from stdin)
  -s, --system <text>    System prompt
  -l, --list             List available model keys
      --list-models      Same as --list
  -j, --json             Output text, model id, and usage as JSON
  -t, --timeout <secs>   Per-request timeout in seconds (default: 300)
  -h, --help             Show this help
`);
}

function loadProductionRuntime() {
  const rootDir = path.dirname(__dirname);
  const configPath = path.join(rootDir, 'lib', 'config.js');
  const llmPath = path.join(rootDir, 'lib', 'llm.js');
  if (!fs.existsSync(configPath) || !fs.existsSync(llmPath)) {
    throw new Error('Foxwarm build output is missing. Run `npm run build` in the Foxwarm checkout first.');
  }

  // The CLI owns stdout; production logs remain available in Foxwarm's normal log file.
  if (!process.env.FOXWARM_NO_CONSOLE_LOG) {
    process.env.FOXWARM_NO_CONSOLE_LOG = '1';
  }
  if (!process.env.FOXWARM_SYNC_FILE_LOG) {
    process.env.FOXWARM_SYNC_FILE_LOG = '1';
  }

  const { loadModelsConfig } = require(configPath);
  const { requestLlmOnce } = require(llmPath);
  return { loadModelsConfig, requestLlmOnce };
}

function readStdin(stream) {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function writeModelList(config, stream) {
  stream.write(`Default: ${config.default || '(none)'}\n\nAvailable models:\n`);
  for (const key of config.displayModels || []) {
    const entry = config.models[key];
    const marker = key === config.default ? ' (default)' : '';
    const modelInfo = entry?.model ? ` -> ${entry.model}` : '';
    stream.write(`  ${key}${marker}${modelInfo}\n`);
    if (entry?.providerType) stream.write(`    provider: ${entry.providerType}\n`);
    if (entry?.baseUrl) stream.write(`    baseUrl:  ${entry.baseUrl}\n`);
  }
}

async function runModelCli(argv, options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const runtimeLoader = options.runtimeLoader || loadProductionRuntime;
  const args = parseArgs(argv);

  if (args.help) {
    printHelp(stdout);
    return 0;
  }

  const runtime = runtimeLoader();
  const modelsConfig = runtime.loadModelsConfig();
  if (args.list) {
    writeModelList(modelsConfig, stdout);
    return 0;
  }

  if (args.model && !modelsConfig.models[args.model]) {
    throw new CliUsageError(`Unknown model key: ${args.model}. Use \`foxwarm model --list\` to inspect configured keys.`);
  }

  const prompt = args.prompt === undefined ? await readStdin(stdin) : args.prompt;
  if (!prompt || !prompt.trim()) {
    throw new CliUsageError('No prompt provided. Use --prompt or pipe text through stdin.');
  }

  const result = await runtime.requestLlmOnce({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemPrompt: args.system,
    model: args.model,
    promptCacheKey: randomUUID(),
    iteration: 0,
    toolDefinitions: [],
    notifySessionEvents: false,
    registerAbortController: false,
    purpose: 'cli',
    timeoutMs: args.timeoutMs,
  });

  if (!result.text || !result.text.trim()) {
    throw new Error('Model returned an empty text response.');
  }

  if (args.json) {
    stdout.write(`${JSON.stringify({
      text: result.text,
      modelId: result.modelId || null,
      usage: result.usage || null,
    }, null, 2)}\n`);
  } else {
    stdout.write(result.text);
    if (!result.text.endsWith('\n')) stdout.write('\n');
  }
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  try {
    return await runModelCli(argv);
  } catch (error) {
    const prefix = error instanceof CliUsageError ? 'Usage error' : 'Error';
    process.stderr.write(`${prefix}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = {
  CliUsageError,
  loadProductionRuntime,
  main,
  parseArgs,
  readStdin,
  runModelCli,
  writeModelList,
};
