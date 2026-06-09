"""
Decision Extractor - ToolScript

Scans user messages from the archive SQLite database, extracts design decisions
using model calls, and embeds them into the appropriate module/thread docs.

Args:
  project: str - project name (default: project)
  output: str - code-index output directory (default: ~/code-index/{project})
  archive_db: str - path to an archive SQLite database with an archive_messages table
  session_like: str - SQL LIKE pattern for sessions to scan (default: %)
  exclude_session_like: list[str] - SQL LIKE patterns to exclude
  batch_size: int - messages per model call (default: 50)
  offset: int - start from this message offset (for resuming)
  dry_run: bool - if true, just print decisions without writing
"""

import json
import os
import shlex


def sql_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def list_module_choices(output_dir):
    """Return existing module names for the extraction prompt."""
    cmd = f"find {shlex.quote(output_dir + '/modules')} -maxdepth 1 -type f -name '*.md' -printf '%f\n' 2>/dev/null"
    raw = call_tool("exec", {"command": cmd})
    modules = []
    if isinstance(raw, str):
        for line in raw.splitlines():
            name = line.strip()
            if name.endswith(".md"):
                modules.append(name[:-3])
    return modules or ["general"]


def extract_user_texts(offset, batch_size, archive_db, session_like, exclude_session_like, tmp_file):
    """Query archive SQLite for user messages with text content."""
    filters = [f"session_id LIKE {sql_quote(session_like)}"]
    for pattern in exclude_session_like:
        filters.append(f"session_id NOT LIKE {sql_quote(pattern)}")
    filter_sql = "\n  AND ".join(filters)
    query = f"""SELECT json_group_array(json_object(
  'session_id', session_id,
  'seq', seq,
  'message_json', message_json
)) FROM (
  SELECT session_id, seq, message_json FROM archive_messages
  WHERE {filter_sql}
  AND role = 'user'
  AND message_json LIKE '%\"text\"%'
  AND LENGTH(message_json) > 200
  ORDER BY timestamp ASC
  LIMIT {batch_size} OFFSET {offset}
);"""
    # Write query result to temp file to avoid exec output truncation
    call_tool("exec", {"command": f"sqlite3 {shlex.quote(archive_db)} {shlex.quote(query)} > {shlex.quote(tmp_file)}"})
    result = call_tool("read", {"filePath": tmp_file})

    messages = []
    if not isinstance(result, str) or not result.strip():
        return []

    try:
        rows = json.loads(result.strip())
    except:
        print(f"  WARNING: Failed to parse JSON from sqlite3 output (len={len(result)})")
        return []

    for row in rows:
        session_id = row.get("session_id", "")
        seq = row.get("seq", 0)
        msg_json_str = row.get("message_json", "")

        # Extract text parts from the JSON
        try:
            msg = json.loads(msg_json_str)
            texts = []
            if "parts" in msg:
                for part in msg["parts"]:
                    if isinstance(part, dict) and "text" in part:
                        texts.append(part["text"])
            if texts:
                text = "\n".join(texts)
                # Skip very short messages (just acknowledgements)
                if len(text) > 30:
                    timestamp = msg.get("__meta", {}).get("timestamp", 0)
                    messages.append({
                        "session": session_id,
                        "seq": str(seq),
                        "timestamp": timestamp,
                        "text": text
                    })
        except:
            continue

    return messages


def extract_decisions_from_batch(messages, module_choices):
    """Call model to identify design decisions in a batch of user messages."""
    # Format messages for the model
    msgs_text = ""
    for m in messages:
        # Truncate very long messages
        text = m["text"][:2000] if len(m["text"]) > 2000 else m["text"]
        msgs_text += f"\n[{m['session']} seq={m['seq']}]\n{text}\n"

    module_list = ", ".join(module_choices)

    prompt = f"""You are extracting design decisions from user messages in a development chat.

A "design decision" is when the user explicitly states:
- How something should work (architecture, behavior, constraints)
- What NOT to do (anti-patterns, rejected approaches)
- Naming conventions or API design choices
- Performance/security/UX requirements
- Workflow rules (e.g., "always do X before Y")

Ignore:
- Simple task assignments ("fix this bug", "add this feature")
- Questions without decisions
- Acknowledgements ("好", "继续", "可以")
- Implementation details that are just following instructions

For each decision found, output a JSON object with:
- "decision": concise statement of the decision (in the language it was made)
- "module": which code-index module it relates to (one of: {module_list})
- "date": approximate date if determinable from context, otherwise null

Output a JSON array of decisions. If no decisions found in this batch, output [].

User messages:
{msgs_text}

Return ONLY the JSON array:"""

    response = request_model_without_context(prompt)
    text = response["text"].strip()

    # Parse JSON
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()

    try:
        decisions = json.loads(text)
        if isinstance(decisions, list):
            return decisions
    except:
        start = text.find("[")
        end = text.rfind("]")
        if start >= 0 and end > start:
            try:
                decisions = json.loads(text[start:end+1])
                if isinstance(decisions, list):
                    return decisions
            except:
                pass

    return []


def embed_decisions(decisions, output_dir, dry_run):
    """Embed decisions into the appropriate module docs."""
    # Group decisions by module
    by_module = {}
    for d in decisions:
        mod = d.get("module", "general")
        if mod not in by_module:
            by_module[mod] = []
        by_module[mod].append(d)

    for mod, mod_decisions in by_module.items():
        module_path = output_dir + "/modules/" + mod + ".md"

        # Check if module file exists - use try/except for ENOENT
        try:
            content = call_tool("read", {"filePath": module_path})
        except:
            # Create a minimal module file for uncategorized decisions
            content = f"# Module: {mod}\n\n## Responsibility\nCross-cutting decisions.\n\n## Design Decisions\n\n"
            call_tool("write", {"filePath": module_path, "content": content, "overwrite": True})

        if not isinstance(content, str):
            print(f"  WARNING: module file not readable: {module_path}")
            continue

        # Build decisions text
        decisions_text = ""
        for d in mod_decisions:
            date_str = d.get("date", "")
            if date_str:
                decisions_text += f"- [{date_str}] {d['decision']}\n"
            else:
                decisions_text += f"- {d['decision']}\n"

        if dry_run:
            print(f"  [DRY RUN] Would add {len(mod_decisions)} decisions to {mod}:")
            print(f"    {decisions_text[:200]}")
            continue

        # Append to Design Decisions section
        if "## Design Decisions" in content:
            # Find the section and append
            idx = content.find("## Design Decisions")
            # Find the end of the section (next ## or end of file)
            next_section = content.find("\n## ", idx + 20)
            if next_section < 0:
                # Append at end
                new_content = content.rstrip() + "\n" + decisions_text + "\n"
            else:
                # Insert before next section
                new_content = content[:next_section] + decisions_text + "\n" + content[next_section:]
            call_tool("write", {"filePath": module_path, "content": new_content, "overwrite": True})
            print(f"  added {len(mod_decisions)} decisions to {mod}")
        else:
            # Add section at end
            new_content = content.rstrip() + "\n\n## Design Decisions\n\n" + decisions_text + "\n"
            call_tool("write", {"filePath": module_path, "content": new_content, "overwrite": True})
            print(f"  added Design Decisions section with {len(mod_decisions)} decisions to {mod}")


def main(args):
    project = args.get("project", "project")
    output_dir = os.path.abspath(os.path.expanduser(args.get("output", "~/code-index/" + project)))
    archive_db = args.get("archive_db")
    if archive_db:
        archive_db = os.path.abspath(os.path.expanduser(archive_db))
    session_like = args.get("session_like", "%")
    exclude_session_like = args.get("exclude_session_like", [])
    if isinstance(exclude_session_like, str):
        exclude_session_like = [exclude_session_like]
    batch_size = args.get("batch_size", 50)
    offset = args.get("offset", 0)
    dry_run = args.get("dry_run", False)
    max_batches = args.get("max_batches", 5)  # Safety limit per run
    tmp_file = "/tmp/skill-index-decisions-" + project.replace("/", "_") + ".json"

    if not archive_db:
        print("Decision Extractor requires args.archive_db (path to an archive SQLite database with an archive_messages table).")
        return {"status": "error", "message": "archive_db is required"}

    module_choices = list_module_choices(output_dir)

    print(f"Decision Extractor")
    print(f"  output: {output_dir}")
    print(f"  archive_db: {archive_db}")
    print(f"  session_like: {session_like}")
    print(f"  exclude_session_like: {exclude_session_like}")
    print(f"  modules: {module_choices}")
    print(f"  batch_size: {batch_size}")
    print(f"  offset: {offset}")
    print(f"  dry_run: {dry_run}")
    print(f"  max_batches: {max_batches}")

    all_decisions = []
    batches_processed = 0

    current_offset = offset
    while batches_processed < max_batches:
        messages = extract_user_texts(current_offset, batch_size, archive_db, session_like, exclude_session_like, tmp_file)
        if not messages:
            print(f"\n  No more messages at offset {current_offset}")
            break

        print(f"\n  Batch {batches_processed + 1}: {len(messages)} messages (offset {current_offset})")

        decisions = extract_decisions_from_batch(messages, module_choices)
        print(f"  Found {len(decisions)} decisions")

        if decisions:
            all_decisions += decisions
            if not dry_run:
                embed_decisions(decisions, output_dir, dry_run)

        current_offset += batch_size
        batches_processed += 1

    print(f"\n  Total: {len(all_decisions)} decisions from {batches_processed} batches")
    print(f"  Next offset: {current_offset}")

    return {
        "status": "ok",
        "decisions_found": len(all_decisions),
        "batches_processed": batches_processed,
        "next_offset": current_offset,
        "decisions": all_decisions
    }
