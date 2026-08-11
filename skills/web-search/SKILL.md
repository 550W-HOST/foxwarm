---
name: web-search
description: Fallback-only recent/public web search via OpenAI Responses or Gemini; do not load or run when the current model/provider already has built-in/native web search or from an isolated session/environment.
---

# web-search

`web-search` is the renamed replacement for the old `ask-gemini` skill. Use it when you need recent or external public information that may be newer than the model's built-in knowledge.

## Boundary: fallback only

Do not load or run this skill when the current model/provider already exposes built-in/native web search; use that capability directly instead. Do not use this skill from an isolated session or environment.

## First step: run the script

Call the bundled helper directly first. If it is not configured yet, it prints a clear setup guide.

```bash
node skills/web-search/web-search.js "What's the latest TypeScript stable version?"
```

```bash
echo "Summarize today's major AI model releases in 5 bullet points" | node skills/web-search/web-search.js
```

Check configuration without making an API request:

```bash
node skills/web-search/web-search.js --check-config
```

If OpenAI-specific web-search secrets are missing, the same script can inspect Foxwarm `models.yaml` and show GPT provider/model candidates without printing API keys:

```bash
node skills/web-search/web-search.js --list-gpt-models
```

It can also initialize the web-search secret files from the latest usable GPT candidate in `models.yaml`, again without printing the key:

```bash
node skills/web-search/web-search.js --init-from-models
```

Use `--models-config /path/to/models.yaml`, `--provider-key <provider>`, or `--model <model>` when you need to choose a non-default config entry.

## What it does

The helper script:

- accepts a question from command-line arguments or stdin
- prefers OpenAI/GPT via the Responses API built-in web search tool
- uses `tools: [{ type: "web_search" }]` by default, with `tool_choice: "required"`
- supports custom OpenAI-compatible base URLs
- falls back to Gemini with `google_search` when OpenAI is not configured and Gemini is configured
- uses a shared 240-second request timeout for both OpenAI and Gemini searches
- can read existing Foxwarm model configuration to list GPT candidates or copy a selected GPT entry into local web-search secret files without exposing the API key
- defaults to OpenAI model `gpt-5.6-sol` and Gemini model `gemini-2.5-flash`
- prints only the answer/reference content on success
- shows a friendly setup guide instead of a raw missing-key error on first use

## Preferred setup: OpenAI / GPT web search

Environment variables:

```bash
export WEB_SEARCH_OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
export WEB_SEARCH_OPENAI_MODEL="gpt-5.6-sol"
export WEB_SEARCH_OPENAI_BASE_URL="https://api.openai.com/v1"  # optional/custom gateway
```

Or local secret files (do not commit these):

```bash
mkdir -p ~/.secrets
chmod 700 ~/.secrets
printf '%s\n' 'YOUR_OPENAI_API_KEY' > ~/.secrets/web_search_openai_api_key
printf '%s\n' 'gpt-5.6-sol' > ~/.secrets/web_search_openai_model
printf '%s\n' 'https://api.openai.com/v1' > ~/.secrets/web_search_openai_base_url
chmod 600 ~/.secrets/web_search_openai_*
```

Supported OpenAI-related configuration names:

- API key: `WEB_SEARCH_OPENAI_API_KEY`, then `OPENAI_API_KEY`, then `~/.secrets/web_search_openai_api_key`, then `~/.secrets/openai_api_key`
- Base URL: `WEB_SEARCH_OPENAI_BASE_URL`, then `OPENAI_BASE_URL`, then `~/.secrets/web_search_openai_base_url`, then `~/.secrets/openai_base_url`, then `https://api.openai.com/v1`
- Model: `WEB_SEARCH_OPENAI_MODEL`, then `OPENAI_WEB_SEARCH_MODEL`, then `~/.secrets/web_search_openai_model`, then `~/.secrets/openai_web_search_model`, then `gpt-5.6-sol`
- Tool type override: `WEB_SEARCH_OPENAI_TOOL_TYPE` (default `web_search`; use `web_search_preview` only for legacy gateways)
- Tool choice override: `WEB_SEARCH_OPENAI_TOOL_CHOICE` or `--tool-choice` (default `required`; use `auto` if search should be optional)

If no OpenAI-specific key is configured, the script also checks Foxwarm `models.yaml` for usable GPT-series entries and can use the latest candidate directly for that run. It never prints API key values.

Per-run overrides:

```bash
node skills/web-search/web-search.js --provider openai --model gpt-5.6-sol --base-url https://api.openai.com/v1 "What changed in the OpenAI web search API recently?"
```

Initialize from an existing Foxwarm model config:

```bash
node skills/web-search/web-search.js --init-from-models
# or choose explicitly:
node skills/web-search/web-search.js --init-from-models --provider-key openai --model gpt-5.6-sol
```

This writes `~/.secrets/web_search_openai_api_key`, `~/.secrets/web_search_openai_model`, and `~/.secrets/web_search_openai_base_url`. Existing files are not overwritten unless you add `--force`.

## Preserved Gemini setup

The old Gemini configuration method still works:

```bash
export GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
# or
export GOOGLE_API_KEY="YOUR_GEMINI_API_KEY"
```

Or store it in a local secret file:

```bash
mkdir -p ~/.secrets
chmod 700 ~/.secrets
printf '%s\n' 'YOUR_GEMINI_API_KEY' > ~/.secrets/gemini_api_key
chmod 600 ~/.secrets/gemini_api_key
```

Optional:

```bash
export GEMINI_MODEL="gemini-2.5-flash"
```

Force Gemini for one run:

```bash
node skills/web-search/web-search.js --provider gemini "What's new in Node.js 24?"
```

## Usage guidance for agents

- Prefer concise factual questions.
- Treat the output as external information and verify it for high-stakes decisions.
- If the answer is important, mention that it came from external web search rather than local memory.
- If first use fails because configuration is missing, relay the setup guide to the user instead of paraphrasing it as a generic tool error.
