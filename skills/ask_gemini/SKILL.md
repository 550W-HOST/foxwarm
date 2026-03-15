---
name: ask_gemini
description: Use the bundled Gemini helper to fetch recent or public information, with setup guidance when the API key is not configured yet.
---

# ask_gemini

Use this skill when you need recent or external public information that may be newer than the model's built-in knowledge.

## What it does

The bundled helper script:

- accepts a question from command-line arguments or stdin
- calls Gemini with `google_search` enabled for fresher/public information
- prefers concise, downstream-AI-friendly answer formatting
- defaults to model `gemini-2.5-flash`
- prints only the answer text on success
- shows a friendly setup guide instead of a raw missing-key error on first use

## First-time setup

Before first use, configure a Gemini API key with **one** of these options:

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

## Quick checks

Verify whether the current shell/machine is already configured:

```bash
node skills/ask_gemini/ask-gemini.js --check-config
```

If the key is missing, the script prints setup instructions and exits non-zero.

## Usage

```bash
node skills/ask_gemini/ask-gemini.js "What's the latest TypeScript stable version?"
```

```bash
echo "Summarize today's major AI model releases in 5 bullet points" | node skills/ask_gemini/ask-gemini.js
```

## Usage guidance for agents

- Prefer concise factual questions.
- Treat the output as external information and verify it for high-stakes decisions.
- If the answer is important, mention that it came from Gemini / external lookup rather than local memory.
- If first use fails because the key is missing, relay the setup guide to the user instead of paraphrasing it as a generic tool error.