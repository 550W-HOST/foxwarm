# Agent Skill Creator (Foxwarm bundled adaptation)

This bundled skill adapts the upstream [Agent Skill Creator](https://github.com/FrancyJGLisboa/agent-skill-creator) project for Foxwarm.

## Attribution

- Upstream project: `https://github.com/FrancyJGLisboa/agent-skill-creator`
- Upstream commit vendored/adapted: `f8ebbf6fe9262b716b02790fcd75f9922c3c048b`
- Upstream version: `6.0.0`
- License: MIT; see `LICENSE`.

The Foxwarm `SKILL.md` entry point was rewritten to fit Foxwarm's SKILL.md-first loader and tool terminology. Companion references and helper scripts are adapted from upstream and kept as explicit files linked from `SKILL.md`.

## Foxwarm notes

- Load the skill with `skill({ action: "load", skillName: "agent-skill-creator" })` to read the Foxwarm entry point.
- Read `references/` files explicitly when deeper upstream methodology is needed.
- Helper scripts live under `scripts/` and should be run by path from this skill directory.
- Do not assume upstream platform installer behavior is the right action for a Foxwarm deployment; prefer generating Foxwarm-compatible skills under the user's chosen workspace.

## Included upstream materials

The tracked contents of this skill directory are the bundled materials. They
currently include:

- Core reference docs under `references/`.
- Helper scripts under `scripts/`.
- Artifact templates and examples referenced by the methodology.
- Tracked static/demo assets under `assets/`.
- Upstream project, contribution, launch, and design/history documents retained
  for provenance or reference.
- The upstream license, citation, and Contributor Covenant files. The bundled
  Contributor Covenant is explicitly marked as an upstream document and does
  not designate a Foxwarm enforcement contact.

Repository metadata such as upstream `.git` internals and GitHub automation is
not part of the bundled skill. For the canonical and complete upstream tree,
use the upstream URL above.
