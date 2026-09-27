"""
Code Index Generator - ToolScript

Generates a layered code index for a project using model calls.

This is a Foxwarm ToolScript. Run it with the `run_script` tool rather than
directly with Python; it uses host APIs such as `call_tool(...)` and
`request_model_without_context(...)`.

Args:
  project: str - project name (used for ~/code-index/{project}/; default: source directory name)
  source: str - absolute path to project source root (default: current working directory)
  phase: str (optional) - run only this phase: "plan", "units", "modules", "threads", "overview"
  files: list (optional) - restrict to these specific files (for testing)
  output: str (optional) - override output directory
  extensions: list (optional) - file extensions to include (default: common source/doc extensions)
"""

import json


def shell_quote(value):
    """Quote one value for the POSIX shell commands dispatched through call_tool."""
    return "'" + str(value).replace("'", "'\"'\"'") + "'"


def absolute_path(value):
    """Expand ~/ and resolve a POSIX path without importing host filesystem modules."""
    path = str(value)
    if path == "~" or path.startswith("~/"):
        home = call_tool("exec", {"command": "printf '%s\\n' \"$HOME\""}).strip()
        if not home.startswith("/"):
            raise ValueError("Could not resolve the ToolScript host home directory")
        path = home + path[1:]
    elif path.startswith("~"):
        raise ValueError("Only ~/ home-relative paths are supported")

    if not path.startswith("/"):
        cwd = call_tool("exec", {"command": "pwd -P"}).strip()
        if not cwd.startswith("/"):
            raise ValueError("Could not resolve the ToolScript host working directory")
        path = cwd.rstrip("/") + "/" + path

    parts = []
    for part in path.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    return "/" + "/".join(parts)


def path_basename(value):
    path = str(value).rstrip("/")
    if not path:
        return ""
    return path.rsplit("/", 1)[-1]


INCLUDE_EXTENSIONS = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift",
    ".cs", ".c", ".cc", ".cpp", ".h", ".hpp",
    ".rb", ".php", ".sh", ".bash", ".zsh",
    ".md", ".mdx", ".json", ".yaml", ".yml", ".toml",
]

# Directories to exclude from scanning
EXCLUDE_DIRS = [
    ".git", "node_modules", "dist", "build", "coverage", ".next", ".vite",
    "target", "vendor", "__pycache__", ".temp", "tmp", "logs", "lib",
    "test/state", "test/agents", "state",
]

EXCLUDE_EXTENSIONS = [
    ".map", ".d.ts", ".min.js", ".bundle.js", ".lock",
]

CODE_INDEX_GOVERNANCE_PROMPT = """Code-index governance:
- Write concise, public-safe English only.
- Never copy secrets, real credentials, local usernames/home-directory paths, private deployment/runbook details, or agent-private collaboration memory.
- Use source-relative paths. If an environment-specific source-code literal is essential to explain behavior, keep it minimal and label it explicitly as a source-code literal; never copy a real secret value.
- Prefer stable symbols and section names over brittle line numbers.
- Each source file has one primary-owning unit; mention other files only as secondary/integration references.
- Treat the index as a current map, not an append-only changelog. Do not invent Design Decisions; put uncertainty in Open Questions labeled Unconfirmed.
- A decision has one canonical owner: unit for one semantic unit, module for several units in one module, thread for a cross-module contract, or overview for a project-wide principle. Other layers use only a short summary and canonical link.
- Repeated decisions across modules signal a thread. A repeated critical security/data-integrity/persisted-data/external-contract invariant must be the same short sentence verbatim and include its canonical link or ID.
"""


def scan_files(source, files_filter, include_extensions):
    """Scan source tree and return list of {path, lines} dicts."""
    if files_filter:
        result = []
        for f in files_filter:
            full_path = f if f.startswith("/") else source + "/" + f
            rel_path = f if not f.startswith("/") else f.replace(source + "/", "")
            wc = call_tool("exec", {"command": f"wc -l < {shell_quote(full_path)} 2>/dev/null || echo 0"})
            lines_str = wc.strip()
            lines = int(lines_str) if lines_str.isdigit() else 0
            result.append({"path": rel_path, "lines": lines})
        return result

    # Prefer git-tracked files; fall back to find for non-git projects.
    cmd = (
        f"cd {shell_quote(source)} && "
        "(git ls-files 2>/dev/null || find . -type f | sed 's#^./##')"
    )
    raw = call_tool("exec", {"command": cmd})
    all_files = [f.strip() for f in raw.strip().split("\n") if f.strip()]

    # Filter excluded dirs and extensions
    filtered = []
    for f in all_files:
        skip = False
        for exc in EXCLUDE_DIRS:
            if f.startswith(exc + "/") or ("/" + exc + "/") in f:
                skip = True
                break
        if skip:
            continue
        for ext in EXCLUDE_EXTENSIONS:
            if f.endswith(ext):
                skip = True
                break
        if include_extensions and not any(f.endswith(ext) for ext in include_extensions):
            skip = True
        if skip:
            continue
        filtered.append(f)

    if not filtered:
        return []

    # Batch wc -l
    files_arg = " ".join([shell_quote(source + "/" + f) for f in filtered[:200]])
    wc_out = call_tool("exec", {"command": f"wc -l {files_arg} 2>/dev/null | grep -v ' total$'"})

    result = []
    for line in wc_out.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            lines = int(parts[0])
            file_path = parts[1].replace(source + "/", "")
            if file_path in filtered:
                result.append({"path": file_path, "lines": lines})

    # Add any files that wc missed
    found_paths = [r["path"] for r in result]
    for f in filtered[:200]:
        if f not in found_paths:
            result.append({"path": f, "lines": 0})

    return result


def plan_groupings(file_list, source):
    """Call model to plan semantic unit groupings."""
    file_summary = "\n".join([f"  {f['path']} ({f['lines']} lines)" for f in file_list])

    prompt = f"""You are planning semantic unit groupings for a code index.

Given this list of source files with line counts, group them into semantic units for documentation.

Rules:
- Small files (< 200 lines) should be grouped with related files from the same directory or logical area
- Large files (> 500 lines) should be their own unit
- Medium files (200-500 lines) are typically their own unit
- Test files (*.test.ts) should be grouped with their corresponding source file's unit
- Group assignment means primary ownership; later integration references do not own the file
- Each unit gets a short kebab-case name for its output filename

Output a JSON array where each item is:
{{"name": "unit-name", "files": ["path1.ts", "path2.ts"], "description": "brief description"}}

Source files:
{file_summary}

Return ONLY the JSON array, no markdown fences, no other text.

{CODE_INDEX_GOVERNANCE_PROMPT}"""

    response = request_model_without_context(prompt)
    text = response["text"].strip()

    # Strip markdown code fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    try:
        groupings = json.loads(text)
        if isinstance(groupings, list):
            return groupings
    except:
        pass

    # Fallback: try to find JSON array in the text
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        try:
            groupings = json.loads(text[start:end+1])
            if isinstance(groupings, list):
                return groupings
        except:
            pass

    print(f"WARNING: Failed to parse groupings. Using fallback (one unit per file).")
    print(f"Model response preview: {text[:300]}")
    return [{"name": f["path"].replace("/", "-").replace(".ts", "").replace(".tsx", ""), "files": [f["path"]], "description": f["path"]} for f in file_list]


def generate_units(groupings, source, output_dir):
    """Generate unit summary files."""
    results = []

    for group in groupings:
        name = group["name"]
        files = group["files"]
        description = group.get("description", "")

        print(f"  generating unit: {name} ({len(files)} files)")

        # Read file contents (truncate very large files)
        file_contents = []
        for f in files:
            full_path = source + "/" + f
            content = call_tool("read", {"filePath": full_path})
            if isinstance(content, str) and len(content) > 12000:
                content = content[:8000] + "\n\n... [TRUNCATED - " + str(len(content)) + " chars total] ...\n\n" + content[-3000:]
            file_contents.append({"path": f, "content": content if isinstance(content, str) else str(content)})

        # Build prompt
        files_text = ""
        for fc in file_contents:
            files_text += f"\n### File: {fc['path']}\n```typescript\n{fc['content']}\n```\n"

        prompt = f"""You are generating a code index unit summary.

Unit: {name}
Description: {description}
Files: {', '.join(files)}

Analyze the source code and produce a concise unit summary in markdown.

Treat the listed files as this unit's primary-owned files. Mention any other file only as a secondary/integration reference.

Include these sections:
## Purpose
What this unit does (1-3 sentences)

## Primary Files
Source-relative files this unit owns

## Secondary / Integration Files
Files referenced for integration context but not owned (omit if none)

## Key Exports
Main types, classes, functions exported (bullet list)

## Function Index
A markdown table of ALL named functions/methods in this unit (exported AND internal helpers).
Columns: Function | Stable location (symbol/section; line optional) | Description (one phrase)
Example row: | `advanceExecution(args)` | `advanceExecution` | Main interpreter loop, dispatches host calls |
Include every function that is 5+ lines. Order by appearance in file.

## Dependencies
Key imports from other project modules (not external packages)

## Behavior
Important logic, state changes, side effects (concise)

## Integration
How this connects to other parts of the system

Keep it concise and factual. Do NOT include source code.

Source:{files_text}

{CODE_INDEX_GOVERNANCE_PROMPT}

Write the markdown summary now (start with ## Purpose):"""

        response = request_model_without_context(prompt)
        summary = response["text"].strip()

        # Write unit file
        unit_path = output_dir + "/units/" + name + ".md"
        header = f"# Unit: {name}\n\nPrimary files: {', '.join(files)}\n\n"
        call_tool("write", {"filePath": unit_path, "content": header + summary, "overwrite": True})
        results.append({"name": name, "path": unit_path, "files": files})

    return results


def generate_modules(output_dir):
    """Generate module-level summaries from unit docs (two-step: plan then generate)."""
    units_raw = call_tool("exec", {"command": f"ls {shell_quote(output_dir + '/units/')} 2>/dev/null"})
    unit_files = [f.strip() for f in units_raw.strip().split("\n") if f.strip().endswith(".md")]

    if not unit_files:
        print("No unit files found, skipping modules phase")
        return []

    # Step 1: Read just the first few lines (Purpose) of each unit for a compact summary
    unit_briefs = []
    unit_full = {}
    for uf in unit_files:
        content = call_tool("read", {"filePath": output_dir + "/units/" + uf})
        if isinstance(content, str):
            unit_full[uf] = content
            # Extract just the header + purpose section (first ~10 lines)
            lines = content.split("\n")
            brief = "\n".join(lines[:12])
            unit_briefs.append(f"- {uf}: {brief.split('## Purpose')[-1].strip()[:200]}")

    briefs_text = "\n".join(unit_briefs)

    # Step 2: Ask model to plan module groupings (lightweight call)
    plan_prompt = f"""You are planning module groupings for a code index with {len(unit_files)} units.

Each unit is listed below with a brief purpose. Group them into 8-12 logical modules.

Output a JSON array where each item is:
{{"name": "module-name", "units": ["unit-file1.md", "unit-file2.md"], "responsibility": "one sentence"}}

Unit briefs:
{briefs_text}

Return ONLY the JSON array, no markdown fences, no other text.

{CODE_INDEX_GOVERNANCE_PROMPT}"""

    response = request_model_without_context(plan_prompt)
    text = response["text"].strip()

    # Parse JSON
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    module_plan = None
    try:
        module_plan = json.loads(text)
    except:
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            try:
                module_plan = json.loads(text[start:end+1])
            except:
                pass

    if not module_plan or not isinstance(module_plan, list):
        print(f"WARNING: Failed to parse module plan. Model response:\n{text[:500]}")
        return []

    print(f"  module plan: {len(module_plan)} modules")

    # Step 3: For each module, feed its unit summaries and generate the module doc
    modules = []
    for mod in module_plan:
        mod_name = mod.get("name", "unknown")
        mod_units = mod.get("units", [])
        mod_resp = mod.get("responsibility", "")

        print(f"  generating module: {mod_name} ({len(mod_units)} units)")

        # Collect full content of relevant units
        relevant_content = ""
        for uf in mod_units:
            if uf in unit_full:
                relevant_content += f"\n---\n{unit_full[uf]}\n"

        if not relevant_content:
            continue

        mod_prompt = f"""You are generating a module-level summary for a code index.

Module: {mod_name}
Responsibility: {mod_resp}
Units: {', '.join(mod_units)}

Based on the unit summaries below, write a module document with these sections:

## Responsibility
What this module owns (2-3 sentences)

## Key Units
List each unit with a one-line description

## Public Interfaces
How other modules interact with this one (key functions, events, data flows)

## Invariants
Important constraints and rules

## Open Questions
Unconfirmed items only, each labeled Unconfirmed

## Design Decisions
(leave empty for now - will be filled from user decision history)

Unit summaries:
{relevant_content}

Do not copy unit-owned decisions; add only summary links if the input already provides a canonical decision reference.

{CODE_INDEX_GOVERNANCE_PROMPT}

Write the module document now (start with ## Responsibility):"""

        response = request_model_without_context(mod_prompt)
        mod_content = response["text"].strip()

        module_path = output_dir + "/modules/" + mod_name + ".md"
        header = f"# Module: {mod_name}\n\n"
        call_tool("write", {"filePath": module_path, "content": header + mod_content, "overwrite": True})
        modules.append({"name": mod_name, "path": module_path})

    return modules


def generate_threads(output_dir):
    """Generate cross-module thread docs from module summaries."""
    modules_raw = call_tool("exec", {"command": f"ls {shell_quote(output_dir + '/modules/')} 2>/dev/null"})
    module_files = [f.strip() for f in modules_raw.strip().split("\n") if f.strip().endswith(".md")]

    if not module_files:
        print("No module files found, skipping threads phase")
        return []

    # Read module summaries (these should be manageable size)
    module_contents = ""
    for mf in module_files:
        content = call_tool("read", {"filePath": output_dir + "/modules/" + mf})
        if isinstance(content, str):
            # Truncate each module to keep total reasonable
            module_contents += f"\n---\n{content[:3000]}\n"

    prompt = f"""You are generating cross-module feature flow documentation.

Based on the module summaries below, identify 4-6 key cross-module flows and document each. Repeated cross-module contracts or decisions are strong signals for thread selection.

A thread describes an end-to-end feature spanning multiple modules. Good threads might include:
- Request lifecycle (input → orchestration → execution → response)
- State lifecycle (creation → mutation → persistence → recovery)
- Tool or plugin dispatch (schema → resolution → execution → result formatting)
- Streaming or event pipeline (producer → backend events → client/consumer rendering)
- External integration flow (connection → request handling → error recovery)

For each thread, write a complete markdown document. Separate threads with:
===THREAD: thread-name===
(content)
===END===

Each thread should have: ## Overview, ## Steps (numbered), ## Modules Involved, ## Key Files, ## Design Decisions (empty)

Module summaries:
{module_contents}

{CODE_INDEX_GOVERNANCE_PROMPT}

Generate the thread documents now:"""

    response = request_model_without_context(prompt)
    text = response["text"].strip()

    threads = []
    parts = text.split("===THREAD:")
    for part in parts[1:]:
        end_idx = part.find("===END===")
        if end_idx < 0:
            end_idx = len(part)
        header_end = part.find("===\n")
        if header_end < 0:
            header_end = part.find("===")
        if header_end < 0:
            continue

        name = part[:header_end].strip()
        content = part[header_end+4:end_idx].strip()

        thread_path = output_dir + "/threads/" + name + ".md"
        call_tool("write", {"filePath": thread_path, "content": f"# Thread: {name}\n\n{content}", "overwrite": True})
        threads.append({"name": name, "path": thread_path})
        print(f"  wrote: threads/{name}.md")

    return threads


def generate_overview(output_dir, project):
    """Generate top-level overview from modules and threads."""
    all_content = ""

    modules_raw = call_tool("exec", {"command": f"ls {shell_quote(output_dir + '/modules/')} 2>/dev/null"})
    for mf in [f.strip() for f in modules_raw.strip().split("\n") if f.strip().endswith(".md")]:
        content = call_tool("read", {"filePath": output_dir + "/modules/" + mf})
        if isinstance(content, str):
            all_content += f"\n---\nModule: {mf}\n{content[:2000]}\n"

    threads_raw = call_tool("exec", {"command": f"ls {shell_quote(output_dir + '/threads/')} 2>/dev/null"})
    for tf in [f.strip() for f in threads_raw.strip().split("\n") if f.strip().endswith(".md")]:
        content = call_tool("read", {"filePath": output_dir + "/threads/" + tf})
        if isinstance(content, str):
            all_content += f"\n---\nThread: {tf}\n{content[:1500]}\n"

    prompt = f"""You are generating the top-level overview for project "{project}".

Write a concise overview covering:
1. **What this project is** (1-2 paragraphs)
2. **Architecture** - module map and connections
3. **Core Design Principles**
4. **Tech Stack**
5. **Module Index** - list with one-line descriptions
6. **Thread Index** - list with one-line descriptions

Keep it navigational and concise.
Do not copy module/thread decisions into the overview; use short links unless a principle is genuinely project-wide and overview-owned.

Source material:
{all_content}

{CODE_INDEX_GOVERNANCE_PROMPT}

Write the overview markdown now:"""

    response = request_model_without_context(prompt)
    overview = response["text"].strip()

    overview_path = output_dir + "/overview.md"
    call_tool("write", {"filePath": overview_path, "content": f"# {project} — Code Index\n\n{overview}", "overwrite": True})


def main(args):
    source = args.get("source")
    if not source:
        source = call_tool("exec", {"command": "pwd"}).strip()
    source = absolute_path(source)

    project = args.get("project") or path_basename(source) or "project"
    phase = args.get("phase", None)
    files_filter = args.get("files", None)
    include_extensions = args.get("extensions", INCLUDE_EXTENSIONS)
    output_dir = absolute_path(args.get("output", "~/code-index/" + project))

    print(f"Code Index Generator")
    print(f"  project: {project}")
    print(f"  source: {source}")
    print(f"  output: {output_dir}")
    print(f"  phase: {phase or 'all'}")
    if files_filter:
        print(f"  files filter: {files_filter}")

    # Ensure output directories exist
    call_tool("exec", {"command": f"mkdir -p {shell_quote(output_dir + '/units')} {shell_quote(output_dir + '/modules')} {shell_quote(output_dir + '/threads')}"})

    # Phase 1: Scan & Plan
    if phase is None or phase == "plan" or phase == "units":
        file_list = scan_files(source, files_filter, include_extensions)
        print(f"\nScanned {len(file_list)} files")

        if not file_list:
            print("No files found!")
            return {"status": "error", "message": "No files found"}

        groupings = plan_groupings(file_list, source)
        print(f"\nPlanned {len(groupings)} unit groups")

        if phase == "plan":
            return {"status": "ok", "phase": "plan", "groups": groupings}

    # Phase 2: Generate unit summaries
    if phase is None or phase == "units":
        results = generate_units(groupings, source, output_dir)
        print(f"\nGenerated {len(results)} unit files")

        if phase == "units":
            return {"status": "ok", "phase": "units", "units": results}

    # Phase 3: Generate module summaries
    if phase is None or phase == "modules":
        modules = generate_modules(output_dir)
        print(f"\nGenerated {len(modules)} module files")

        if phase == "modules":
            return {"status": "ok", "phase": "modules", "modules": modules}

    # Phase 4: Generate thread docs
    if phase is None or phase == "threads":
        threads = generate_threads(output_dir)
        print(f"\nGenerated {len(threads)} thread files")

        if phase == "threads":
            return {"status": "ok", "phase": "threads", "threads": threads}

    # Phase 5: Generate overview
    if phase is None or phase == "overview":
        generate_overview(output_dir, project)
        print(f"\nGenerated overview.md")

        if phase == "overview":
            return {"status": "ok", "phase": "overview"}

    return {"status": "ok", "phase": "all"}
