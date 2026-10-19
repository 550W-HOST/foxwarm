# Unit: node-development-workflow

Files: skills/node-setup/examples/development_workflow.py, skills/node-setup/tests/test_development_workflow.py, skills/node-setup/tests/development-workflow.test.js
Secondary files: skills/node-setup/SKILL.md, skills/node-setup/references/development-workflow.md, Dockerfile

## Purpose

A portable public ToolScript example for development assignments on an existing non-master Node. The `node-setup` skill exposes the workflow reference and its executable resource; neither requires importing a Foxwarm source checkout or a private Provider controller.

## Function index

| Function | Responsibility |
| --- | --- |
| `main(args)` | Dispatch explicit prepare, assign, snapshot, receive or collect phases; retain actual receipts and partial successes on failure |
| `execute(state, options)` | Route one ordinary exec to the exact Node and interpret retained completion data without replay |
| `parse_capture(state, capture)` | Read the example's final JSON summary only from complete programmatic content |
| `transfer(state, ...)` | Use standard cross-Node copy without overwrite and retain each successful receipt |
| Embedded `_NODE_SCRIPT` | Run ordinary Python/Git through Node exec to initialize a new workspace or snapshot committed/dirty state |

## Behavior

- Supported environments provide POSIX shells, Python 3, Git, canonical file/exec tools and retained programmatic text. Dependencies and containment are administrator provisioning, not helper effects.
- Prepare accepts a locally produced source bundle, exact committed base, new worker workspace, local Git identity and chosen materials. It transfers with public tools, initializes a repository and verifies the bundle HEAD before checkout. It never creates a receiving coordinator worktree.
- Assignment creates a Task or deliberately reuses an existing Task ID, then creates a Task-linked child on the prepared Node. Display name is explicit or the actual Task title. Caller-written handoff fields remain intact; model/effort defaults are not inferred. Native receipts and actual Task notification state distinguish confirmed assignment from an uncertain result.
- Snapshot reports actual base/HEAD, commit IDs and NUL-separated porcelain dirty state. It requires base ancestry and creates a bundle only for new commits. Uncommitted files are not silently included. Evidence-only delivery has no fake bundle, ref or commit.
- Receive copies the optional bundle and selected evidence to a chosen existing artifact directory. Import, review, integration, push and cleanup remain deliberate coordinator actions.
- Failed/pending exec stops later work and retains the exact Node, exec/log information and previous receipts. Collect reads an actually completed log without replaying commands. Unavailable/truncated content is not reconstructed from display text. Partial transfer files, repositories and Task/child resources are not rolled back or automatically retried.
- The workflow reference links to `access-control` as canonical policy syntax owner and distinguishes reusable caller/Provider scope from per-assignment permission bindings, OS isolation and Provider-specific lifecycle. The optional [SSH adapter](./example-linux-ssh-provider.md) has no host provisioning/destruction lifecycle.

## Packaging and validation

The runtime Dockerfile ships `skills/`, not root examples/docs. Keeping the helper, workflow reference and canonical SSH adapter under the skill makes their required runtime files available in an installed/copied skill directory. Optional protocol deep reading is not a runtime dependency.

Python fixtures execute real local Git preparation, committed bundle roundtrip, dirty reporting, evidence-only receipt, partial copy/setup failures, pending collection and Task/child receipt handling. Installed-shape fixtures copy only the skill and run preparation plus SSH `describe` without network. JavaScript tests run the ToolScript under the locked Monty runtime with local Git and synthetic public-tool responses. Existing generic transfer/policy and opt-in loopback SSH transport tests remain their own coverage; these examples do not introduce another transport or policy engine.
