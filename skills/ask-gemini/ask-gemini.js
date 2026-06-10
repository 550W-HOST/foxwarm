#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const DEFAULT_SECRET_PATHS = [
  path.join(os.homedir(), '.secrets', 'gemini_api_key'),
  path.join(os.homedir(), '.secrets', 'google_api_key'),
];

const DEFAULT_SYSTEM_INSTRUCTION = [
  'You are being used as a recent-information lookup helper for another AI assistant.',
  'Your output will be consumed as external reference material, not shown as a casual end-user chat reply.',
  'For recent, current, latest, today, this week, this month, this year, version, release, pricing, policy, news, or other time-sensitive questions, prefer Google Search results instead of relying only on parametric memory.',
  'Prioritize factual accuracy, recency, professional wording, clear structure, and key dates, versions, and qualifiers when relevant.',
  'Unless the user explicitly requests a different format, prefer this structure when appropriate: (1) a direct answer first, (2) a compact set of key supporting details, and (3) a short uncertainty/conflict note only if needed.',
  'When useful, anchor claims with concrete dates, version numbers, release stage, region, or other scope conditions so the downstream assistant can reason about them reliably.',
  'If search results are insufficient, ambiguous, or conflicting, say so briefly and explicitly.',
  'Do not include filler, self-referential AI disclaimers, or commentary about your internal process.',
  'Return only the answer content.',
].join(' ');

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

function loadApiKey() {
  if (process.env.GEMINI_API_KEY?.trim()) {
    return {
      value: process.env.GEMINI_API_KEY.trim(),
      source: 'GEMINI_API_KEY',
    };
  }

  if (process.env.GOOGLE_API_KEY?.trim()) {
    return {
      value: process.env.GOOGLE_API_KEY.trim(),
      source: 'GOOGLE_API_KEY',
    };
  }

  return readFirstExistingSecret(DEFAULT_SECRET_PATHS);
}

function buildMissingKeyGuidance() {
  return [
    'Gemini API key is not configured yet.',
    '',
    'To enable the bundled ask-gemini skill, configure one of these options:',
    '',
    '1. Environment variable',
    '   export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"',
    '   # or',
    '   export GOOGLE_API_KEY="YOUR_GEMINI_API_KEY"',
    '',
    '2. Local secret file',
    '   mkdir -p ~/.secrets',
    '   chmod 700 ~/.secrets',
    '   printf \'%s\\n\' "YOUR_GEMINI_API_KEY" > ~/.secrets/gemini_api_key',
    '   chmod 600 ~/.secrets/gemini_api_key',
    '',
    'Optional:',
    '   export GEMINI_MODEL="gemini-2.5-flash"',
    '',
    'Then retry:',
    '   node skills/ask-gemini/ask-gemini.js "What\'s the latest TypeScript stable version?"',
  ].join('\n');
}

function printUsage() {
  console.error([
    'Usage: ask-gemini.js [--check-config] <question>',
    '',
    'Examples:',
    '  node skills/ask-gemini/ask-gemini.js "Summarize this week\'s major AI model releases"',
    '  echo "What\'s new in Node.js 24?" | node skills/ask-gemini/ask-gemini.js',
    '  node skills/ask-gemini/ask-gemini.js --check-config',
  ].join('\n'));
}

function extractText(responseData) {
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

async function main() {
  const args = process.argv.slice(2);
  const wantsHelp = args.includes('--help') || args.includes('-h');
  const wantsConfigCheck = args.includes('--check-config');
  const cleanedArgs = args.filter(arg => arg !== '--help' && arg !== '-h' && arg !== '--check-config');

  if (wantsHelp) {
    printUsage();
    process.exit(0);
  }

  const { value: apiKey, source: apiKeySource } = loadApiKey();

  if (wantsConfigCheck) {
    if (!apiKey) {
      console.error(buildMissingKeyGuidance());
      process.exit(2);
    }

    console.log(`ask-gemini is configured (${apiKeySource || 'configured'}).`);
    process.exit(0);
  }

  const questionFromArgs = cleanedArgs.join(' ').trim();
  const questionFromStdin = questionFromArgs ? '' : await readQuestionFromStdin();
  const question = questionFromArgs || questionFromStdin;

  if (!question) {
    printUsage();
    process.exit(1);
  }

  if (!apiKey) {
    console.error(buildMissingKeyGuidance());
    process.exit(2);
  }

  const model = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  try {
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
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );

    const text = extractText(response.data);
    if (!text) {
      console.error('Gemini returned no text content.');
      process.exit(1);
    }

    process.stdout.write(text);
  } catch (error) {
    const status = error?.response?.status;
    const message = error?.response?.data?.error?.message || error?.message || 'Unknown Gemini API error';

    if (status === 400 || status === 401 || status === 403) {
      console.error([
        `Gemini API ${status}: ${message}`,
        '',
        'Check that your Gemini API key is valid and has access to the Gemini API.',
        'If this is your first time using ask-gemini on this machine, configure a key with one of these:',
        '  export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"',
        '  export GOOGLE_API_KEY="YOUR_GEMINI_API_KEY"',
        '  printf \'%s\\n\' "YOUR_GEMINI_API_KEY" > ~/.secrets/gemini_api_key',
      ].join('\n'));
      process.exit(1);
    }

    if (status) {
      console.error(`Gemini API ${status}: ${message}`);
    } else {
      console.error(message);
    }
    process.exit(1);
  }
}

main();