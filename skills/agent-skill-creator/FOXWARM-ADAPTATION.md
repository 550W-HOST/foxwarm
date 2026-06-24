# Agent Skill Creator (Foxwarm bundled adaptation)

This bundled skill adapts the upstream [Agent Skill Creator](https://github.com/FrancyJGLisboa/agent-skill-creator) project for Foxwarm.

## Attribution

- Upstream project: `https://github.com/FrancyJGLisboa/agent-skill-creator`
- Upstream commit vendored/adapted: `f8ebbf6fe9262b716b02790fcd75f9922c3c048b`
- Upstream version: `6.0.0`
- License: MIT; see `LICENSE`.

The Foxwarm `SKILL.md` entry point was rewritten to fit Foxwarm's SKILL.md-first loader and tool terminology. Companion references and helper scripts are adapted from upstream and kept as explicit files linked from `SKILL.md`.

## Foxwarm notes

- Load the skill with `load_skill("agent-skill-creator")` to read the Foxwarm entry point.
- Read `references/` files explicitly when deeper upstream methodology is needed.
- Helper scripts live under `scripts/` and should be run by path from this skill directory.
- Do not assume upstream platform installer behavior is the right action for a Foxwarm deployment; prefer generating Foxwarm-compatible skills under the user's chosen workspace.

## Included upstream materials

Included:

- Core reference docs under `references/`.
- Helper scripts under `scripts/`.
- Small artifact template files under `references/artifact-templates/`.
- Small static/reference assets and superpower design notes needed by upstream docs.

Excluded from the bundled copy to keep Foxwarm lightweight:

- `.git`, GitHub workflow/issue templates, launch docs, contribution docs.
- Large demo media (`assets/demo.gif`, `assets/demo.cast`).
- Upstream examples and script test fixtures.

For the full upstream repository, use the upstream URL above.
