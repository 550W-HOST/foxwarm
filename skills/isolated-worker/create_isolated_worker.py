import re


_NODE_ID_RE = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
_SAFE_NAME_RE = r"[A-Za-z0-9_-]+"
_HANDOFF_CONFIRMATION_PREFIX = "Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?"
_HANDOFF_REVIEW_PLACEHOLDER = "<replace this with your own non-empty review; do not copy this placeholder verbatim>"
_HANDOFF_CONFIRMATION_SUFFIX = "I have completed the check, found no issue, and confirm this inter-agent handoff should proceed."


def _handoff_confirmation(review):
    return f"{_HANDOFF_CONFIRMATION_PREFIX}\n{review}\n{_HANDOFF_CONFIRMATION_SUFFIX}"


def _required_text(args, key):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value.strip()


def _required_task(args):
    value = args.get("task")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("task must be a non-empty string")
    return value


def _safe_name(value, key):
    if re.fullmatch(_SAFE_NAME_RE, value) is None:
        raise ValueError(f"{key} must use only letters, digits, hyphens, and underscores")
    return value


def _node_id(value):
    if re.fullmatch(_NODE_ID_RE, value) is None:
        raise ValueError("nodeId must be 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen, starting with a letter or digit")
    if value.lower() == "master":
        raise ValueError("nodeId must be a non-master node")
    return value


def _extract_backtick_field(text, label):
    marker = f"- {label}: `"
    start = text.find(marker)
    if start < 0:
        raise ValueError(f"Could not resolve {label} from session status")
    value_start = start + len(marker)
    value_end = text.find("`", value_start)
    if value_end < 0:
        raise ValueError(f"Could not parse {label} from session status")
    return text[value_start:value_end]


def _agent_exists(listing, agent_name):
    return f"- **{agent_name}**" in listing


def _parse_node_listing(listing):
    if not isinstance(listing, str):
        raise ValueError("node list returned an unexpected result")
    lines = listing.split("\n")
    if not lines:
        raise ValueError("node list returned an empty result")
    found_header = re.fullmatch(r"Found ([0-9]+) node\(s\)\. Current node: `([^`]+)`\.", lines[0])
    empty_header = re.fullmatch(r"No nodes registered\. Current node: `([^`]+)`\.", lines[0])
    if found_header is None and empty_header is None:
        raise ValueError("node list returned a malformed topology header")
    expected_node_count = 0 if found_header is None else int(found_header.group(1))
    header_indexes = [index for index, line in enumerate(lines) if line == "Lifecycle providers:"]
    if len(header_indexes) > 1:
        raise ValueError("node list returned multiple Lifecycle providers sections")
    provider_start = header_indexes[0] if header_indexes else len(lines)
    nodes = {}
    for line in lines[:provider_start]:
        if not line.startswith("- `"):
            continue
        match = re.fullmatch(r"- `([^`]+)` \((local|remote|sandbox)\)(?: ✅ current)?(?: - Last activity: .+)?", line)
        if match is None or re.fullmatch(_NODE_ID_RE, match.group(1)) is None:
            raise ValueError("node list returned a malformed Node row")
        node_id = match.group(1)
        if node_id in nodes:
            raise ValueError(f"node list returned duplicate Node {node_id}")
        nodes[node_id] = True
    if len(nodes) != expected_node_count:
        raise ValueError("node list topology count does not match its Node rows")

    return nodes


def _node_cleanup():
    return {
        "automatic": False,
        "recommendDestroy": False,
        "note": "This workflow did not create or ensure the existing Node; retain it unless the operator manages it separately.",
    }


def _recovery(agent_name, session_id, stage, agent_exists, session_exists):
    notes = []
    if stage == "create_agent":
        if agent_exists:
            notes.append(f"Agent {agent_name} was detected after the create_agent error; no worker session was created.")
        else:
            notes.append("The worker agent was not detected after the create_agent error, and no worker session was created.")
    elif stage == "create_session":
        notes.append(f"Agent {agent_name} exists; the worker session was not created. Retry create_session after fixing the reported error.")
    elif stage == "send_task":
        notes.append(f"Agent {agent_name} and session {session_id} exist; retry send_to_session after fixing the reported error.")
    recovery = {
        "notes": notes,
        "nodeCleanup": _node_cleanup(),
    }
    if agent_exists:
        recovery["agentCleanup"] = f"User-confirmed cleanup: /agent delete {agent_name} --confirm"
    if session_exists:
        recovery["sessionRetry"] = f"Retry send_to_session to {session_id} after fixing the reported error."
    return recovery


def _surviving_resources(node_id, agent_exists=False, agent_name=None,
                         session_exists=False, session_id=None):
    resources = {"nodeId": node_id}
    if agent_exists:
        resources["agentName"] = agent_name
    if session_exists:
        resources["sessionId"] = session_id
    return resources


def _handoff_message(node_id, task):
    lines = [
        "You are a temporary isolated development worker with a narrowly assigned environment.",
        "",
        f"Assigned Node: `{node_id}`.",
    ]
    lines.extend([
        "",
        "User task (verbatim):",
        "<foxwarm-task>",
        task,
        "</foxwarm-task>",
        "",
        "Constraints:",
        "- Work only in the assigned Node/environment.",
        "- Do not select, create, ensure, inspect, destroy, or otherwise manage Nodes or Node lifecycle unless the verbatim user task explicitly requires that exact action.",
        "- Do not create child sessions unless the verbatim user task explicitly requires that exact action.",
        "- Do not commit, push, restart, or deploy unless the verbatim user task explicitly requires that exact action.",
    ])
    lines.extend([
        "",
        "When finished, report exactly to the parent with:",
        'send_to_session({sessionId: "<parent>", message: "...", afterSend: "finish", confirmation: "'
        + _HANDOFF_CONFIRMATION_PREFIX
        + '\\n' + _HANDOFF_REVIEW_PLACEHOLDER + '\\n'
        + _HANDOFF_CONFIRMATION_SUFFIX
        + '"})',
        "When the current tool schema requires confirmation, it must be the final argument property; replace the placeholder with your own review and do not copy it verbatim. When the schema omits confirmation, the property may be omitted; the shown form remains accepted in both modes.",
        "The report must include changed files and a diff summary, validation commands/results, blockers or unresolved questions, and whether working-tree changes remain. Do not assume or claim that a commit exists.",
    ])
    return "\n".join(lines)


def main(args):
    if not isinstance(args, dict):
        raise ValueError("args must be an object")

    node_id_raw = _required_text(args, "nodeId")
    if args.get("nodeId") != node_id_raw:
        raise ValueError("nodeId must be exact without leading or trailing whitespace")
    node_id = _node_id(node_id_raw)

    agent_name = _safe_name(_required_text(args, "agentName"), "agentName")
    if agent_name == "main":
        raise ValueError("agentName must be a new non-main agent")

    session_name = args.get("sessionName", "worker")
    if not isinstance(session_name, str) or not session_name.strip():
        raise ValueError("sessionName must be a non-empty string")
    session_name = _safe_name(session_name.strip(), "sessionName")

    task = _required_task(args)
    inherit_agent = args.get("inheritAgent")
    if inherit_agent is not None:
        if not isinstance(inherit_agent, str) or not inherit_agent.strip():
            raise ValueError("inheritAgent must be a non-empty agent name when provided")
        inherit_agent = _safe_name(inherit_agent.strip(), "inheritAgent")

    dry_run = args.get("dryRun", True)
    if not isinstance(dry_run, bool):
        raise ValueError("dryRun must be true or false")

    status = call_tool({"toolId": "builtin:session", "args": {}})
    if not isinstance(status, str):
        raise ValueError("session status returned an unexpected result")
    current_parent = _extract_backtick_field(status, "session id")
    current_node_line = ""
    for line in status.split("\n"):
        if line.startswith("- current node:"):
            current_node_line = line
    if "(isolated)" in current_node_line:
        raise ValueError("The coordinator session is isolated and cannot create another agent/session")

    requested_parent = args.get("parentSessionId")
    if requested_parent is not None:
        if not isinstance(requested_parent, str) or not requested_parent.strip():
            raise ValueError("parentSessionId must be a non-empty string when provided")
        requested_parent = requested_parent.strip()
        if requested_parent != current_parent:
            raise ValueError("parentSessionId must match the current ToolScript owner session")
    parent_session_id = current_parent

    nodes = call_tool({"toolId": "builtin:node", "args": {"action": "list"}})
    parsed_listing = _parse_node_listing(nodes)
    if node_id not in parsed_listing:
        raise ValueError(f"Node {node_id} is not currently connected; start/approve it before creating the worker")

    agents = call_tool({"toolId": "builtin:list_agents", "args": {}})
    if not isinstance(agents, str):
        raise ValueError("list_agents returned an unexpected result")
    if _agent_exists(agents, agent_name):
        raise ValueError(f"Agent {agent_name} already exists; choose a unique temporary agent name")
    if inherit_agent is not None and not _agent_exists(agents, inherit_agent):
        raise ValueError(f"Inherited agent {inherit_agent} does not exist")

    session_id = f"{agent_name}/{session_name}"
    handoff = _handoff_message(node_id, task)
    plan = {
        "mode": "existing_node",
        "node": {
            "nodeId": node_id,
            "presentInPreflight": True,
            "validation": "listed_online",
        },
        "worker": {
            "agentName": agent_name,
            "sessionName": session_name,
            "sessionId": session_id,
            "parentSessionId": parent_session_id,
            "isolatedNode": node_id,
            "inheritAgent": inherit_agent,
        },
        "handoff": {
            "targetSessionId": session_id,
            "reportTo": parent_session_id,
            "message": handoff,
        },
        "steps": ["create_agent", "create_session", "send_to_session"],
        "atomic": False,
        "cleanup": {
            "agent": f"User-confirmed cleanup: /agent delete {agent_name} --confirm",
            "node": _node_cleanup(),
        },
    }

    if dry_run:
        print("validation passed; no node, agent, or session mutation was performed")
        return {"status": "dry_run", "plan": plan, "mutations": []}

    completed = []
    create_agent_args = {
        "agentName": agent_name,
        "isolatedNode": node_id,
        "createMainSession": False,
    }
    if inherit_agent is not None:
        create_agent_args["inherit"] = inherit_agent

    try:
        call_tool({"toolId": "builtin:create_agent", "args": create_agent_args})
        completed.append("create_agent")
    except Exception as error:
        exists_after_error = False
        try:
            refreshed_agents = call_tool({"toolId": "builtin:list_agents", "args": {}})
            exists_after_error = isinstance(refreshed_agents, str) and _agent_exists(refreshed_agents, agent_name)
        except Exception:
            exists_after_error = False
        return {
            "status": "partial_failure" if exists_after_error else "failed",
            "failedStage": "create_agent",
            "error": str(error),
            "plan": plan,
            "completedStages": completed,
            "agentDetectedAfterError": exists_after_error,
            "survivingResources": _surviving_resources(node_id, exists_after_error, agent_name),
            "recovery": _recovery(
                agent_name, session_id, "create_agent", exists_after_error, False,
            ),
        }

    try:
        call_tool({
            "toolId": "builtin:create_session",
            "args": {
                "agentName": agent_name,
                "sessionName": session_name,
                "parentSessionId": parent_session_id,
            },
        })
        completed.append("create_session")
    except Exception as error:
        return {
            "status": "partial_failure",
            "failedStage": "create_session",
            "error": str(error),
            "plan": plan,
            "completedStages": completed,
            "survivingResources": _surviving_resources(node_id, True, agent_name),
            "recovery": _recovery(
                agent_name, session_id, "create_session", True, False,
            ),
        }

    try:
        send_confirmation = _handoff_confirmation(
            "I checked that this isolated-worker assignment is necessary, accurately targets the created session, contains the complete scoped brief, and follows the parent-child communication rules."
        )
        call_tool({
            "toolId": "builtin:send_to_session",
            "args": {"sessionId": session_id, "message": handoff, "confirmation": send_confirmation},
        })
        completed.append("send_to_session")
    except Exception as error:
        return {
            "status": "partial_failure",
            "failedStage": "send_task",
            "error": str(error),
            "plan": plan,
            "completedStages": completed,
            "survivingResources": _surviving_resources(node_id, True, agent_name, True, session_id),
            "recovery": _recovery(
                agent_name, session_id, "send_task", True, True,
            ),
        }

    print(f"isolated worker ready: {session_id} on {node_id}")
    result = {
        "status": "completed",
        "mode": plan["mode"],
        "agentName": agent_name,
        "sessionId": session_id,
        "nodeId": node_id,
        "parentSessionId": parent_session_id,
        "completedStages": completed,
        "atomic": False,
        "cleanup": {
            "agent": f"User-confirmed cleanup: /agent delete {agent_name} --confirm",
            "node": _node_cleanup(),
        },
    }
    return result
