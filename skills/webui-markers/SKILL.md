---
name: webui-markers
description: "Use Foxwarm WebUI interactive output markers, especially when presenting a real Git commit the agent has just created so the user can open its details and diffs in Code. Load this before emitting `<foxwarm-commit ... />`, before embedding a prepared artifact between prose paragraphs, or when asked about WebUI marker syntax."
license: MIT
activation: /webui-markers
metadata:
  author: Foxwarm project
  version: 1.0.0
  created: 2026-07-15
  last_reviewed: 2026-07-15
  review_interval_days: 180
provenance:
  maintainer: Foxwarm project
  source_references:
    - Foxwarm WebUI commit marker protocol
---

# WebUI Markers

Use this skill when a response in Foxwarm WebUI should contain a supported interactive marker. Markers are optional presentation hints embedded in otherwise ordinary model text.

Commit cards and prepared artifact references are supported. Use only the implemented protocols below; markers do not grant access to resources.

## Commit marker

After a Git commit has **actually been created**, you may include this marker so WebUI renders an **Open in Code** commit card:

```text
<foxwarm-commit node="master" path="/absolute/path/to/repository" id="0123456789abcdef" />
```

Use the real values from the environment where the commit exists:

- `node` — exact Foxwarm node id containing the repository, such as `master` or a connected remote node id.
- `path` — absolute POSIX path to the repository/worktree on that node. A subdirectory inside the same repository is accepted, but the repository root is preferable.
- `id` — real hexadecimal commit id. A unique 7–64 character abbreviation is accepted; prefer the full id when practical.

Do not emit a commit marker for a planned commit, an uncommitted working tree, a guessed id, a tag/tree/blob, or a commit that was created on a different node/path. If any value is uncertain, report the commit normally without a marker.

## Commit placement and escaping

- Put the marker on its own line at column 0.
- Use the exact lowercase, self-closing tag name and double-quoted attributes.
- Keep normal prose on separate lines. Do not put the marker in a list, blockquote, inline sentence, Markdown code span, or fenced code block.
- Include exactly `node`, `path`, and `id`; do not add commands, URLs, event handlers, or extra attributes.
- XML-escape attribute values: `&` → `&amp;`, `"` → `&quot;`, `'` → `&apos;`, `<` → `&lt;`, and `>` → `&gt;`.

Example response:

```text
Implemented and committed the fix as `0123456789ab`.

<foxwarm-commit node="worker-1" path="/srv/project" id="0123456789abcdef0123456789abcdef01234567" />
```

## Commit safety and failure behavior

The marker is not a tool call and does not execute automatically. WebUI validates it and shows the node, path, and id; Git data is fetched only after the user clicks the card. Code then resolves the commit, adds the canonical repository root to its persistent workspace without duplicating an existing root, and opens a read-only details/diff panel.

Malformed markers are inert. A valid historical marker may later fail if its node is offline, its path moved, or the commit was removed/garbage-collected. In those cases, preserve the truthful text response and let the UI report the lookup error; never replace the id with a guess.

Outside Foxwarm WebUI, channels may display the marker as plain text. Use it only when the active user interaction is through WebUI or the user explicitly requests the marker syntax.

## Artifact marker

Use `artifact` with `action:"prepare"` to save an immutable chart, React preview or raster image in the current Session. Copy the exact returned `marker` into ordinary assistant prose:

```text
The next figure shows the result.

<foxwarm-artifact id="art_0123456789abcdef0123456789abcdef" revision="1" />

A brief caption or explanation follows the figure.
```

Replace the example ID/revision with the real returned values. Put the tag on its own line at column 0, separated from adjacent paragraphs by blank lines. Include only `id` and `revision`, with double quotes. Do not put an active reference inside a code fence, list, quote, user message or tool output. Use ordinary prose for captions; no extra marker attributes are supported.

- Chart/React source: `{action:"prepare",filePath:"manifest.json",node?}`. Load `data-visualization` or `react-artifacts` for formats.
- Raster image: `{action:"prepare",type:"image",filePath:"figure.png",title?,alt?,node?}`. PNG/JPEG/GIF/WebP, at most 12 MiB; source bytes are snapshotted, not referenced by a live path.
- Existing snapshot: `{action:"get",artifactId,revision?}` returns a reference to the exact revision. Only artifacts owned by the current Session can be embedded.
- Standalone card: `action:"publish"` retains reply-end display. If the same revision is embedded in that reply, its tail card is suppressed.
- File attachment: use `send_file`; file delivery is independent of body figures.

Complete references load near the viewport; React still requires the user's Run action. Later text does not reset an existing preview. Every resource request rechecks Session access and exact revision ownership. Invalid, missing and inaccessible references never substitute a new revision or execute arbitrary source text. Other clients may show the marker literally, so use these only for WebUI output.
