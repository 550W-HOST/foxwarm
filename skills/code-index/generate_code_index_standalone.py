#!/usr/bin/env python3
"""Generate a layered code index using Foxwarm's production model CLI."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shlex
import shutil
import subprocess
import sys
import tempfile


GENERATOR_SCHEMA_VERSION = 2
INCLUDE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
    ".java", ".kt", ".kts", ".swift", ".cs", ".c", ".cc", ".cpp", ".h",
    ".hpp", ".rb", ".php", ".sh", ".bash", ".zsh", ".md", ".mdx",
    ".json", ".yaml", ".yml", ".toml", ".vue", ".less", ".scss", ".css",
}
EXCLUDE_DIRS = {
    ".git", "node_modules", "dist", "build", "coverage", ".next", ".vite",
    "target", "vendor", "__pycache__", ".temp", "tmp", "logs", "lib", "state",
}
EXCLUDE_SUFFIXES = (".map", ".d.ts", ".min.js", ".bundle.js", ".lock", ".bak")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


class GeneratorError(RuntimeError):
    """Expected, user-facing generator failure."""


class ModelCallError(GeneratorError):
    pass


class ValidationError(GeneratorError):
    pass


def atomic_write_text(path, content):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=target.parent,
            prefix=f".{target.name}.", suffix=".tmp", delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def atomic_write_json(path, value):
    atomic_write_text(path, json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def ensure_output_directory(output_root, relative_name):
    root = Path(output_root).expanduser().resolve()
    directory = root / relative_name
    directory.mkdir(parents=True, exist_ok=True)
    resolved = directory.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValidationError(f"Output directory escapes the output root: {directory}") from error
    if not resolved.is_dir():
        raise ValidationError(f"Output path is not a directory: {directory}")
    return resolved


def validate_project_name(value):
    if not PROJECT_RE.fullmatch(value) or value in {".", ".."}:
        raise ValidationError(
            "Project name must use only letters, digits, '.', '_', or '-', without path separators."
        )
    return value


def validate_slug(value, kind):
    if not isinstance(value, str) or len(value) > 80 or not SLUG_RE.fullmatch(value):
        raise ValidationError(f"Invalid {kind} name {value!r}; expected a lowercase kebab-case slug.")
    return value


def is_excluded_path(relative_path):
    parts = Path(relative_path).parts
    if any(part in EXCLUDE_DIRS for part in parts[:-1]):
        return True
    return relative_path.endswith(EXCLUDE_SUFFIXES)


def ensure_contained_file(source_root, relative_path, allowed_paths):
    if not isinstance(relative_path, str) or not relative_path:
        raise ValidationError("Model returned an empty or non-string source path.")
    if "\\" in relative_path or Path(relative_path).is_absolute() or PureWindowsPath(relative_path).is_absolute():
        raise ValidationError(f"Source path must be repo-relative: {relative_path!r}")
    parts = Path(relative_path).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ValidationError(f"Unsafe source path: {relative_path!r}")
    normalized = Path(*parts).as_posix()
    if normalized not in allowed_paths:
        raise ValidationError(f"Model returned a file outside the scanned allowlist: {relative_path!r}")
    root = Path(source_root).resolve(strict=True)
    candidate = (root / normalized).resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValidationError(f"Source path escapes the source root: {relative_path!r}") from error
    if not candidate.is_file():
        raise ValidationError(f"Source path is not a regular file: {relative_path!r}")
    return candidate, normalized


def list_candidate_paths(source_root):
    root = Path(source_root).resolve(strict=True)
    try:
        result = subprocess.run(
            ["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True,
        )
        paths = [item.decode("utf-8", errors="surrogateescape") for item in result.stdout.split(b"\0") if item]
    except (FileNotFoundError, subprocess.CalledProcessError):
        paths = [path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()]
    return paths


def scan_files(source_root, files_filter=None):
    root = Path(source_root).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValidationError(f"Source root is not a directory: {root}")

    scanned = []
    scanned_paths = set()
    for relative_path in list_candidate_paths(root):
        if is_excluded_path(relative_path):
            continue
        if Path(relative_path).suffix.lower() not in INCLUDE_EXTENSIONS:
            continue
        try:
            candidate, normalized = ensure_contained_file(root, relative_path, {relative_path})
        except (OSError, ValidationError):
            continue
        with candidate.open("r", encoding="utf-8", errors="ignore") as handle:
            lines = sum(1 for _ in handle)
        scanned.append({"path": normalized, "lines": lines})
        scanned_paths.add(normalized)

    if files_filter:
        selected = []
        seen = set()
        for requested in files_filter:
            _, normalized = ensure_contained_file(root, requested, scanned_paths)
            if normalized not in seen:
                selected.append(next(item for item in scanned if item["path"] == normalized))
                seen.add(normalized)
        scanned = selected

    return sorted(scanned, key=lambda item: item["path"])


def resolve_foxwarm_cli(override=None):
    configured = override or os.environ.get("FOXWARM_CLI")
    if configured:
        command = shlex.split(configured)
        if not command:
            raise ValidationError("FOXWARM_CLI/--foxwarm-cli resolved to an empty command.")
        return command
    installed = shutil.which("foxwarm")
    if installed:
        return [installed]
    repo_cli = Path(__file__).resolve().parents[2] / "scripts" / "foxwarm.js"
    if repo_cli.is_file():
        node = shutil.which("node")
        if not node:
            raise ValidationError("Node.js is required to run the repo-local Foxwarm CLI.")
        return [node, str(repo_cli)]
    raise ValidationError("Cannot find `foxwarm` on PATH or the repo-local scripts/foxwarm.js entry.")


def call_model(prompt, model=None, timeout=120, system_prompt=None, cli_command=None):
    if not isinstance(timeout, int) or timeout <= 0:
        raise ValidationError("Model timeout must be a positive integer.")
    command = list(cli_command or resolve_foxwarm_cli()) + ["model"]
    if model:
        command.extend(["--model", model])
    if system_prompt:
        command.extend(["--system", system_prompt])
    command.extend(["--timeout", str(timeout)])
    try:
        result = subprocess.run(
            command, input=prompt, capture_output=True, text=True,
            timeout=timeout + 15, check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise ModelCallError(f"Model command failed: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip()[:1000] or "no stderr"
        raise ModelCallError(f"Model command exited {result.returncode}: {detail}")
    text = result.stdout.strip()
    if not text:
        raise ModelCallError("Model returned an empty response.")
    return text


def parse_json_array(text, label):
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
    try:
        value = json.loads(stripped)
    except json.JSONDecodeError as error:
        raise ValidationError(f"Model returned invalid JSON for {label}: {error}") from error
    if not isinstance(value, list) or not value:
        raise ValidationError(f"Model must return a non-empty JSON array for {label}.")
    return value


def validate_groupings(raw_groupings, source_root, file_list):
    allowed = {item["path"] for item in file_list}
    normalized_groups = []
    seen_names = set()
    seen_files = set()
    for index, raw in enumerate(raw_groupings):
        if not isinstance(raw, dict):
            raise ValidationError(f"Grouping {index} is not an object.")
        name = validate_slug(raw.get("name"), "unit")
        if name in seen_names:
            raise ValidationError(f"Duplicate unit name: {name}")
        files = raw.get("files")
        if not isinstance(files, list) or not files:
            raise ValidationError(f"Unit {name} must contain a non-empty files array.")
        normalized_files = []
        for candidate in files:
            _, normalized = ensure_contained_file(source_root, candidate, allowed)
            if normalized in seen_files:
                raise ValidationError(f"Source file appears in multiple units: {normalized}")
            seen_files.add(normalized)
            normalized_files.append(normalized)
        description = raw.get("description", "")
        if not isinstance(description, str):
            raise ValidationError(f"Unit {name} description must be a string.")
        seen_names.add(name)
        normalized_groups.append({"name": name, "files": normalized_files, "description": description})
    missing = sorted(allowed - seen_files)
    if missing:
        preview = ", ".join(missing[:10])
        raise ValidationError(f"Grouping plan omitted {len(missing)} scanned files: {preview}")
    return normalized_groups


def grouping_cache_inputs(source_root, file_list, project, model, cli_command=None, timeout=120):
    return {
        "schemaVersion": GENERATOR_SCHEMA_VERSION,
        "phase": "groupings",
        "source": str(Path(source_root).resolve()),
        "project": project,
        "model": model or "(configured default)",
        "cliCommand": list(cli_command or []),
        "timeout": timeout,
        "files": file_list,
    }


def cache_fingerprint(inputs):
    encoded = json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_groupings_cache(cache_path, expected_inputs, source_root, file_list):
    path = Path(cache_path)
    if not path.exists():
        return None
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if cache.get("fingerprint") != cache_fingerprint(expected_inputs):
        print("Ignoring stale groupings cache because its source/files/model fingerprint changed.")
        return None
    return validate_groupings(cache.get("groupings"), source_root, file_list)


def save_groupings_cache(cache_path, inputs, groupings):
    atomic_write_json(cache_path, {
        "schemaVersion": GENERATOR_SCHEMA_VERSION,
        "fingerprint": cache_fingerprint(inputs),
        "inputs": inputs,
        "groupings": groupings,
    })


def plan_groupings(file_list, source_root, model=None, timeout=120, cli_command=None):
    summary = "\n".join(f"  {item['path']} ({item['lines']} lines)" for item in file_list)
    prompt = f"""Plan semantic unit groupings for a code index.

Rules:
- Group related small files; large files can be their own unit.
- Keep tests with their source unit.
- Every listed file must appear exactly once.
- Names must be unique lowercase kebab-case slugs.
- Use only paths from the supplied list.

Return ONLY a JSON array of objects:
{{"name":"unit-name","files":["path.ts"],"description":"brief description"}}

Files:\n{summary}"""
    response = call_model(prompt, model=model, timeout=timeout, cli_command=cli_command)
    return validate_groupings(parse_json_array(response, "unit groupings"), source_root, file_list)


def validated_markdown(text, label):
    if not isinstance(text, str) or not text.strip():
        raise ModelCallError(f"Model returned empty markdown for {label}; no file was written.")
    return text.strip() + "\n"


def write_generated_doc(path, content, force=False):
    target = Path(path)
    if target.exists() and not force:
        if target.stat().st_size == 0:
            raise GeneratorError(f"Refusing to treat empty existing document as complete: {target}. Use --force to replace it.")
        print(f"  skip existing (use --force to replace): {target}")
        return False
    atomic_write_text(target, content)
    return True


def read_source_files(source_root, files, allowed_paths):
    chunks = []
    for relative_path in files:
        full_path, normalized = ensure_contained_file(source_root, relative_path, allowed_paths)
        content = full_path.read_text(encoding="utf-8", errors="ignore")
        if len(content) > 12_000:
            content = content[:8_000] + f"\n\n... [TRUNCATED: {len(content)} chars] ...\n\n" + content[-3_000:]
        chunks.append(f"\n### File: {normalized}\n```\n{content}\n```\n")
    return "".join(chunks)


def generate_units(groupings, source_root, output_dir, model=None, timeout=120, cli_command=None, force=False):
    units_dir = ensure_output_directory(output_dir, "units")
    allowed_paths = {item for group in groupings for item in group["files"]}
    results = []
    for index, group in enumerate(groupings, start=1):
        unit_path = units_dir / f"{validate_slug(group['name'], 'unit')}.md"
        if unit_path.exists() and not force:
            write_generated_doc(unit_path, "", force=False)
            results.append({"name": group["name"], "path": str(unit_path), "files": group["files"]})
            continue
        print(f"  [{index}/{len(groupings)}] generating unit: {group['name']}")
        source_text = read_source_files(source_root, group["files"], allowed_paths)
        prompt = f"""Generate a concise code-index unit summary.

Unit: {group['name']}
Description: {group['description']}
Files: {', '.join(group['files'])}

Include: ## Purpose, ## Key Exports, ## Function Index (all named functions/methods of 5+ lines), ## Dependencies, ## Behavior, and ## Integration. Start with ## Purpose. Do not include source code.

Source:{source_text}"""
        summary = validated_markdown(
            call_model(prompt, model=model, timeout=timeout, cli_command=cli_command),
            f"unit {group['name']}",
        )
        content = f"# Unit: {group['name']}\n\nFiles: {', '.join(group['files'])}\n\n{summary}"
        write_generated_doc(unit_path, content, force=force)
        results.append({"name": group["name"], "path": str(unit_path), "files": group["files"]})
    return results

def validate_module_plan(raw_plan, unit_files):
    allowed_units = set(unit_files)
    seen_names = set()
    seen_units = set()
    plan = []
    for index, raw in enumerate(raw_plan):
        if not isinstance(raw, dict):
            raise ValidationError(f"Module plan item {index} is not an object.")
        name = validate_slug(raw.get("name"), "module")
        if name in seen_names:
            raise ValidationError(f"Duplicate module name: {name}")
        units = raw.get("units")
        if not isinstance(units, list) or not units:
            raise ValidationError(f"Module {name} must contain a non-empty units array.")
        for unit in units:
            if unit not in allowed_units:
                raise ValidationError(f"Module {name} references unknown unit document: {unit!r}")
            if unit in seen_units:
                raise ValidationError(f"Unit document appears in multiple modules: {unit}")
            seen_units.add(unit)
        responsibility = raw.get("responsibility", "")
        if not isinstance(responsibility, str):
            raise ValidationError(f"Module {name} responsibility must be a string.")
        seen_names.add(name)
        plan.append({"name": name, "units": units, "responsibility": responsibility})
    missing = sorted(allowed_units - seen_units)
    if missing:
        raise ValidationError(f"Module plan omitted unit documents: {', '.join(missing[:10])}")
    return plan


def generate_modules(output_dir, model=None, timeout=120, cli_command=None, force=False):
    units_dir = ensure_output_directory(output_dir, "units")
    modules_dir = ensure_output_directory(output_dir, "modules")
    existing_modules = sorted(path for path in modules_dir.glob("*.md") if path.is_file())
    if existing_modules and not force:
        empty = [path for path in existing_modules if path.stat().st_size == 0]
        if empty:
            raise GeneratorError(f"Refusing to resume with an empty module document: {empty[0]}. Use --force to regenerate.")
        print("  preserving existing module phase (use --force to regenerate it)")
        return [{"name": path.stem, "path": str(path)} for path in existing_modules]
    unit_files = sorted(path.name for path in units_dir.glob("*.md") if path.is_file() and path.stat().st_size > 0)
    if not unit_files:
        raise GeneratorError("No non-empty unit documents exist; cannot generate modules.")

    unit_full = {name: (units_dir / name).read_text(encoding="utf-8", errors="ignore") for name in unit_files}
    briefs = "\n".join(f"- {name}: {unit_full[name][:500]}" for name in unit_files)
    plan_prompt = f"""Group these code-index units into logical modules.
Every unit must appear exactly once. Names must be unique lowercase kebab-case slugs.
Return ONLY JSON objects shaped as:
{{"name":"module-name","units":["unit.md"],"responsibility":"one sentence"}}

Units:\n{briefs}"""
    raw_plan = parse_json_array(
        call_model(plan_prompt, model=model, timeout=timeout, cli_command=cli_command),
        "module plan",
    )
    module_plan = validate_module_plan(raw_plan, unit_files)

    results = []
    for module in module_plan:
        module_path = modules_dir / f"{module['name']}.md"
        if module_path.exists() and not force:
            write_generated_doc(module_path, "", force=False)
            results.append({"name": module["name"], "path": str(module_path)})
            continue
        source = "\n\n---\n\n".join(unit_full[name] for name in module["units"])
        prompt = f"""Generate a concise code-index module document.
Module: {module['name']}
Responsibility: {module['responsibility']}
Units: {', '.join(module['units'])}

Include: ## Responsibility, ## Key Units, ## Public Interfaces, ## Invariants, and an empty ## Design Decisions section. Start with ## Responsibility.

Unit summaries:\n{source}"""
        summary = validated_markdown(
            call_model(prompt, model=model, timeout=timeout, cli_command=cli_command),
            f"module {module['name']}",
        )
        write_generated_doc(module_path, f"# Module: {module['name']}\n\n{summary}", force=force)
        results.append({"name": module["name"], "path": str(module_path)})
    return results


def parse_threads(text):
    threads = []
    seen_names = set()
    for part in text.split("===THREAD:")[1:]:
        if "===END===" not in part:
            raise ValidationError("Thread response contains an unterminated ===THREAD block.")
        block, _ = part.split("===END===", 1)
        if "===" not in block:
            raise ValidationError("Thread response is missing the name delimiter.")
        raw_name, content = block.split("===", 1)
        name = validate_slug(raw_name.strip(), "thread")
        if name in seen_names:
            raise ValidationError(f"Duplicate thread name: {name}")
        markdown = validated_markdown(content, f"thread {name}")
        seen_names.add(name)
        threads.append({"name": name, "content": markdown})
    if not threads:
        raise ValidationError("Model returned no valid thread blocks.")
    return threads


def generate_threads(output_dir, model=None, timeout=120, cli_command=None, force=False):
    modules_dir = ensure_output_directory(output_dir, "modules")
    threads_dir = ensure_output_directory(output_dir, "threads")
    existing_threads = sorted(path for path in threads_dir.glob("*.md") if path.is_file())
    if existing_threads and not force:
        empty = [path for path in existing_threads if path.stat().st_size == 0]
        if empty:
            raise GeneratorError(f"Refusing to resume with an empty thread document: {empty[0]}. Use --force to regenerate.")
        print("  preserving existing thread phase (use --force to regenerate it)")
        return [{"name": path.stem, "path": str(path)} for path in existing_threads]
    module_files = sorted(path for path in modules_dir.glob("*.md") if path.is_file() and path.stat().st_size > 0)
    if not module_files:
        raise GeneratorError("No non-empty module documents exist; cannot generate threads.")
    source = "\n\n---\n\n".join(path.read_text(encoding="utf-8", errors="ignore")[:3_000] for path in module_files)
    prompt = f"""Identify 4-6 important cross-module flows from these module summaries.
For each flow emit exactly:
===THREAD: lowercase-kebab-name===
## Overview
...
## Steps
...
## Modules Involved
...
## Key Files
...
## Design Decisions
===END===

Module summaries:\n{source}"""
    parsed = parse_threads(call_model(prompt, model=model, timeout=timeout, cli_command=cli_command))
    results = []
    for thread in parsed:
        path = threads_dir / f"{thread['name']}.md"
        content = f"# Thread: {thread['name']}\n\n{thread['content']}"
        wrote = write_generated_doc(path, content, force=force)
        if wrote:
            print(f"  wrote: threads/{thread['name']}.md")
        results.append({"name": thread["name"], "path": str(path)})
    return results


def generate_overview(output_dir, project, model=None, timeout=120, cli_command=None, force=False):
    output = Path(output_dir)
    overview_path = output / "overview.md"
    if overview_path.exists() and not force:
        return write_generated_doc(overview_path, "", force=False)
    module_files = sorted(path for path in (output / "modules").glob("*.md") if path.is_file() and path.stat().st_size > 0)
    thread_files = sorted(path for path in (output / "threads").glob("*.md") if path.is_file() and path.stat().st_size > 0)
    if not module_files:
        raise GeneratorError("No non-empty module documents exist; cannot generate overview.")
    source_parts = [f"Module: {path.name}\n{path.read_text(encoding='utf-8', errors='ignore')[:2_000]}" for path in module_files]
    source_parts.extend(
        f"Thread: {path.name}\n{path.read_text(encoding='utf-8', errors='ignore')[:1_500]}" for path in thread_files
    )
    source_material = "\n\n---\n\n".join(source_parts)
    prompt = f"""Generate a concise, navigational code-index overview for {project}.
Include what the project is, architecture, core design principles, tech stack, module index, and thread index.

Source material:\n{source_material}"""
    overview = validated_markdown(
        call_model(prompt, model=model, timeout=timeout, cli_command=cli_command),
        "overview",
    )
    return write_generated_doc(overview_path, f"# {project} — Code Index\n\n{overview}", force=force)


def parse_files_filter(raw_value):
    if not raw_value:
        return None
    values = [value.strip() for value in raw_value.split(",")]
    if any(not value for value in values):
        raise ValidationError("--files must be a comma-separated list without empty entries.")
    return values


def build_parser():
    parser = argparse.ArgumentParser(description="Generate a layered code index using Foxwarm's production model CLI")
    parser.add_argument("--project", help="Project name (defaults to source directory name)")
    parser.add_argument("--source", default=".", help="Project source root")
    parser.add_argument("--phase", default="all", choices=["plan", "units", "modules", "threads", "overview", "all"])
    parser.add_argument("--files", help="Comma-separated repo-relative scanned files")
    parser.add_argument("--output", help="Output directory (defaults to ~/code-index/<project>)")
    parser.add_argument("--model", help="Configured Foxwarm model key")
    parser.add_argument("--timeout", type=int, default=120, help="Per-model-call timeout in seconds")
    parser.add_argument("--foxwarm-cli", help="Foxwarm CLI command override (also FOXWARM_CLI)")
    parser.add_argument(
        "--force", action="store_true",
        help="Explicitly replace existing generated docs, including any manual edits/design decisions",
    )
    return parser


def run(args):
    source_root = Path(args.source).expanduser().resolve(strict=True)
    project = validate_project_name(args.project or source_root.name or "project")
    output_dir = Path(args.output).expanduser().resolve() if args.output else Path.home() / "code-index" / project
    cli_command = resolve_foxwarm_cli(args.foxwarm_cli)
    if not isinstance(args.timeout, int) or args.timeout <= 0:
        raise ValidationError("--timeout must be a positive integer.")

    print("Code Index Generator")
    print(f"  project: {project}")
    print(f"  source: {source_root}")
    print(f"  output: {output_dir}")
    print(f"  phase: {args.phase}")
    if args.force:
        print("  WARNING: --force permits replacement of existing docs and Design Decisions.")

    for subdirectory in ("units", "modules", "threads", "_work"):
        ensure_output_directory(output_dir, subdirectory)

    groupings = None
    if args.phase in {"all", "plan", "units"}:
        file_list = scan_files(source_root, parse_files_filter(args.files))
        if not file_list:
            raise GeneratorError("No eligible source files found.")
        print(f"  scanned files: {len(file_list)}")
        inputs = grouping_cache_inputs(
            source_root, file_list, project, args.model,
            cli_command=cli_command, timeout=args.timeout,
        )
        cache_path = output_dir / "_work" / "groupings.json"
        groupings = load_groupings_cache(cache_path, inputs, source_root, file_list)
        if groupings is None:
            groupings = plan_groupings(
                file_list, source_root, model=args.model, timeout=args.timeout,
                cli_command=cli_command,
            )
            save_groupings_cache(cache_path, inputs, groupings)
            print(f"  saved grouping cache: {cache_path}")
        else:
            print(f"  loaded {len(groupings)} groups from matching cache")
        if args.phase == "plan":
            print(json.dumps(groupings, indent=2, ensure_ascii=False))
            return

    if args.phase in {"all", "units"}:
        results = generate_units(
            groupings, source_root, output_dir, model=args.model, timeout=args.timeout,
            cli_command=cli_command, force=args.force,
        )
        print(f"Generated/retained {len(results)} unit documents")
        if args.phase == "units":
            return

    if args.phase in {"all", "modules"}:
        modules = generate_modules(
            output_dir, model=args.model, timeout=args.timeout,
            cli_command=cli_command, force=args.force,
        )
        print(f"Generated/retained {len(modules)} module documents")
        if args.phase == "modules":
            return

    if args.phase in {"all", "threads"}:
        threads = generate_threads(
            output_dir, model=args.model, timeout=args.timeout,
            cli_command=cli_command, force=args.force,
        )
        print(f"Generated/retained {len(threads)} thread documents")
        if args.phase == "threads":
            return

    if args.phase in {"all", "overview"}:
        generate_overview(
            output_dir, project, model=args.model, timeout=args.timeout,
            cli_command=cli_command, force=args.force,
        )
        print("Generated/retained overview.md")


def main(argv=None):
    parser = build_parser()
    try:
        run(parser.parse_args(argv))
    except (GeneratorError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"error: {error}\n")


if __name__ == "__main__":
    main()
