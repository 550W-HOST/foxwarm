#!/usr/bin/env node
'use strict';

const { runCoreCli } = require('./core-cli.js');

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
    timeoutMs: undefined,
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
  -t, --timeout <secs>   Explicit whole-attempt upper bound in seconds
                        (streaming otherwise uses 3m first-content / 1m inactivity)
  -h, --help             Show this help
`);
}

async function runModelCli(argv, options = {}) {
  const args = parseArgs(argv);
  const stdout = options.stdout || process.stdout;
  if (args.help) {
    printHelp(stdout);
    return 0;
  }
  return (options.backend || runCoreCli)('model', args, options);
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
  main,
  parseArgs,
  runModelCli,
};
