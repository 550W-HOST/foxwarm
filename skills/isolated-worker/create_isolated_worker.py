import re


def _required_text(args, key):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value.strip()


def _safe_name(value, key):
    if re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        raise ValueError(f"{key} must use only letters, digits, hyphens, and underscores")
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


def _node_connected(listing, node_id):
    marker = f"- `{node_id}`"
    for line in listing.split("\n"):
        if line.startswith(marker):
            return True
    return False


def _recovery(agent_name, session_id, stage):
    notes = []
    if stage == "create_agent":
        notes.append("Inspect list_agents: create_agent can leave an agent directory if its post-create isolation step fails.")
    elif stage == "create_session":
        notes.append(f"Agent {agent_name} exists; retry create_session after fixing the reported error.")
    elif stage == "send_task":
        notes.append(f"Agent {agent_name} and session {session_id} exist; retry send_to_session after fixing the reported error.")
    notes.append(f"If the temporary worker should be discarded, ask the user to run /agent delete {agent_name} --confirm.")
    return notes


def main(args):
    if not isinstance(args, dict):
        raise ValueError("args must be an object")

    node_id = _safe_name(_required_text(args, "nodeId"), "nodeId")
    if node_id == "master":
        raise ValueError("nodeId must be a non-master node")

    agent_name = _safe_name(_required_text(args, "agentName"), "agentName")
    if agent_name == "main":
        raise ValueError("agentName must be a new non-main agent")

    session_name = args.get("sessionName", "worker")
    if not isinstance(session_name, str) or not session_name.strip():
        raise ValueError("sessionName must be a non-empty string")
    session_name = _safe_name(session_name.strip(), "sessionName")

    task = _required_text(args, "task")
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
    if not isinstance(nodes, str) or not _node_connected(nodes, node_id):
        raise ValueError(f"Node {node_id} is not currently connected; start/approve it before creating the worker")

    agents = call_tool({"toolId": "builtin:list_agents", "args": {}})
    if not isinstance(agents, str):
        raise ValueError("list_agents returned an unexpected result")
    if _agent_exists(agents, agent_name):
        raise ValueError(f"Agent {agent_name} already exists; choose a unique temporary agent name")
    if inherit_agent is not None and not _agent_exists(agents, inherit_agent):
        raise ValueError(f"Inherited agent {inherit_agent} does not exist")

    session_id = f"{agent_name}/{session_name}"
    plan = {
        "nodeId": node_id,
        "agentName": agent_name,
        "sessionId": session_id,
        "parentSessionId": parent_session_id,
        "inheritAgent": inherit_agent,
        "steps": ["create_agent", "create_session", "send_to_session"],
    }

    if dry_run:
        print("validation passed; no agent or session was created")
        return {"status": "dry_run", "plan": plan}

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
        stage_status = "partial_failure" if exists_after_error else "failed"
        return {
            "status": stage_status,
            "failedStage": "create_agent",
            "error": str(error),
            "plan": plan,
            "completedStages": completed,
            "agentDetectedAfterError": exists_after_error,
            "recovery": _recovery(agent_name, session_id, "create_agent"),
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
            "recovery": _recovery(agent_name, session_id, "create_session"),
        }

    try:
        call_tool({
            "toolId": "builtin:send_to_session",
            "args": {"sessionId": session_id, "message": task},
        })
        completed.append("send_to_session")
    except Exception as error:
        return {
            "status": "partial_failure",
            "failedStage": "send_task",
            "error": str(error),
            "plan": plan,
            "completedStages": completed,
            "recovery": _recovery(agent_name, session_id, "send_task"),
        }

    print(f"isolated worker ready: {session_id} on {node_id}")
    return {
        "status": "completed",
        "agentName": agent_name,
        "sessionId": session_id,
        "nodeId": node_id,
        "parentSessionId": parent_session_id,
        "completedStages": completed,
        "atomic": False,
        "cleanup": f"User-confirmed cleanup: /agent delete {agent_name} --confirm",
    }
