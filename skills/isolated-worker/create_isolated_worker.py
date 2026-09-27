import re


_NODE_ID_RE = r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"
_PROVIDER_ID_RE = r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
_SAFE_NAME_RE = r"[A-Za-z0-9_-]+"
_EXPECTED_NODE_TOOLS = ["read", "write", "edit", "apply_patch", "exec"]
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


def _provider_id(value):
    if re.fullmatch(_PROVIDER_ID_RE, value) is None:
        raise ValueError("providerId must be 1-64 ASCII letters, digits, dot, underscore, or hyphen, starting with a letter or digit")
    return value


def _worktree_path(value):
    if not isinstance(value, str) or not value:
        raise ValueError("worktreePath must be an exact non-empty absolute path")
    if value != value.strip() or len(value) > 4096 or not value.startswith("/"):
        raise ValueError("worktreePath must be an exact absolute path of at most 4096 characters")
    if re.search(r"[,\x00-\x1f\x7f]", value) is not None:
        raise ValueError("worktreePath must not contain commas or control characters")
    if value != "/" and value.endswith("/"):
        raise ValueError("worktreePath must be lexically canonical without a trailing slash")
    components = [] if value == "/" else value.split("/")[1:]
    if any(component == "" or component == "." or component == ".." for component in components):
        raise ValueError("worktreePath must be lexically canonical without empty, dot, or dot-dot components")
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

    providers = {}
    footer_seen = False
    if header_indexes:
        for line in lines[provider_start + 1:]:
            if line == "":
                continue
            if re.fullmatch(r"Current node `[^`]+` is not currently available\.", line) is not None:
                if footer_seen:
                    raise ValueError("node list returned duplicate current-Node footer")
                footer_seen = True
                continue
            if footer_seen:
                raise ValueError("node list returned content after the current-Node footer")
            match = re.fullmatch(r"- `([^`]+)` \(([^)]*)\)", line)
            if match is None or re.fullmatch(_PROVIDER_ID_RE, match.group(1)) is None:
                raise ValueError("node list returned a malformed lifecycle-provider row")
            provider_id = match.group(1)
            if provider_id in providers:
                raise ValueError(f"node list returned duplicate lifecycle provider {provider_id}")
            actions = [item.strip() for item in match.group(2).split(",") if item.strip()]
            if not actions:
                raise ValueError(f"node list returned no actions for lifecycle provider {provider_id}")
            seen_actions = {}
            for action in actions:
                if action in seen_actions:
                    raise ValueError(f"node list returned duplicate action for lifecycle provider {provider_id}")
                if action not in ["create", "ensure", "inspect", "destroy"]:
                    raise ValueError(f"node list returned an unknown action for lifecycle provider {provider_id}")
                seen_actions[action] = True
            providers[provider_id] = actions
    return {"nodes": nodes, "providers": providers}


def _inspect_node(node_id):
    return call_tool({"toolId": "builtin:node", "args": {"action": "inspect", "nodeId": node_id}})


def _raw_exact_node_present(result, node_id):
    if not isinstance(result, dict):
        return False
    node = result.get("node")
    return isinstance(node, dict) and node.get("id") == node_id


def _validate_provider_result(result, provider_id, node_id, worktree_path, network_mode, label):
    if not isinstance(result, dict):
        raise ValueError(f"{label} returned an unexpected result")
    node = result.get("node")
    if not isinstance(node, dict):
        raise ValueError(f"{label} did not return a Node descriptor")
    expected_fields = {
        "id": node_id,
        "provider": provider_id,
        "kind": "sandbox",
        "type": "docker-worktree",
        "availability": "ready",
        "defaultCwd": worktree_path,
    }
    for key, expected in expected_fields.items():
        if node.get(key) != expected:
            raise ValueError(f"{label} Node {key} mismatch: expected {expected}, got {node.get(key)}")
    tools = node.get("tools")
    if not isinstance(tools, list):
        raise ValueError(f"{label} Node tools must be an array")
    tool_names = []
    for tool in tools:
        if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
            raise ValueError(f"{label} Node tools contain an invalid descriptor")
        tool_names.append(tool.get("name"))
    if tool_names != _EXPECTED_NODE_TOOLS:
        raise ValueError(f"{label} Node tools mismatch: expected {', '.join(_EXPECTED_NODE_TOOLS)}")
    details = result.get("details")
    if not isinstance(details, dict):
        raise ValueError(f"{label} did not return Docker worktree details")
    if details.get("worktreePath") != worktree_path:
        raise ValueError(f"{label} worktreePath mismatch: expected {worktree_path}, got {details.get('worktreePath')}")
    if details.get("networkMode") != network_mode:
        raise ValueError(f"{label} networkMode mismatch: expected {network_mode}, got {details.get('networkMode')}")
    if details.get("status") != "running":
        raise ValueError(f"{label} status mismatch: expected running, got {details.get('status')}")
    return {
        "node": node,
        "details": details,
        "effect": result.get("effect"),
        "dataRetention": result.get("dataRetention"),
    }


def _node_cleanup(provider_mode, node_id, node_existed_before, node_presence_after_ensure, node_validated):
    if not provider_mode:
        return {
            "automatic": False,
            "recommendDestroy": False,
            "note": "This workflow did not create or ensure the existing Node; retain it unless the operator manages it separately.",
        }
    if node_existed_before:
        return {
            "automatic": False,
            "recommendDestroy": False,
            "note": "The Node existed before this run. Retain it by default; agent binding does not imply Node ownership.",
        }
    if node_presence_after_ensure == "present" and node_validated:
        return {
            "automatic": False,
            "recommendDestroy": False,
            "note": "The Node was absent in preflight and present after ensure, but that does not prove this workflow created or owns it because there is no lease. Retain it by default. A non-isolated coordinator may separately inspect and explicitly destroy it only with independent operator/workflow confirmation that it is disposable.",
        }
    if node_presence_after_ensure == "present":
        return {
            "automatic": False,
            "recommendDestroy": False,
            "note": "The Node was absent in preflight and present after ensure, but exact inspect validation did not complete and ownership is unconfirmed because there is no lease. Retain it by default; inspect separately before any independently authorized lifecycle action.",
        }
    return {
        "automatic": False,
        "recommendDestroy": False,
        "note": "The Node was absent in preflight, but its state after ensure is unconfirmed. This workflow cannot infer creation or ownership. Retain by default and inspect separately before any independently authorized lifecycle action.",
    }


def _planned_node_cleanup(provider_mode, node_id, node_existed_before):
    if not provider_mode or node_existed_before:
        return _node_cleanup(provider_mode, node_id, node_existed_before, "unknown", node_existed_before)
    return {
        "automatic": False,
        "recommendDestroy": False,
        "note": "Dry run performs no Node mutation. A later ensure cannot prove ownership from preflight absence because no lease exists; retain the Node by default unless an operator independently confirms it is disposable.",
    }


def _recovery(agent_name, session_id, stage, provider_mode, node_id, node_existed_before,
              node_presence_after_ensure, node_validated, agent_exists, session_exists):
    notes = []
    if stage == "ensure_node":
        if node_presence_after_ensure == "present":
            notes.append(f"Provider ensure failed, but raw post-error inspect proves exact Node {node_id} is present; full workflow validation may still have failed.")
        else:
            notes.append(f"Provider ensure failed and exact Node {node_id} presence afterward is unknown; inspect it separately before any lifecycle action.")
        notes.append("The worker agent and session were not created.")
    elif stage == "inspect_node":
        notes.append(f"Node {node_id} exists after ensure, but exact descriptor/worktree/network validation did not complete.")
        notes.append("The worker agent and session were not created.")
    elif stage == "create_agent":
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
        "nodeCleanup": _node_cleanup(provider_mode, node_id, node_existed_before, node_presence_after_ensure, node_validated),
    }
    if agent_exists:
        recovery["agentCleanup"] = f"User-confirmed cleanup: /agent delete {agent_name} --confirm"
    if session_exists:
        recovery["sessionRetry"] = f"Retry send_to_session to {session_id} after fixing the reported error."
    return recovery


def _surviving_resources(node_exists, node_id, agent_exists=False, agent_name=None,
                         session_exists=False, session_id=None):
    resources = {}
    if node_exists:
        resources["nodeId"] = node_id
    if agent_exists:
        resources["agentName"] = agent_name
    if session_exists:
        resources["sessionId"] = session_id
    return resources


def _node_presence_resources(node_presence_after_ensure, node_id):
    if node_presence_after_ensure == "present":
        return {"nodeId": node_id}
    return {"possibleNodeId": node_id}


def _handoff_message(node_id, task, worktree_path=None):
    lines = [
        "You are a temporary isolated development worker with a narrowly assigned environment.",
        "",
        f"Assigned Node: `{node_id}`.",
    ]
    if worktree_path is not None:
        lines.append(f"Assigned canonical worktree: `{worktree_path}`.")
    lines.extend([
        "",
        "User task (verbatim):",
        "<foxwarm-task>",
        task,
        "</foxwarm-task>",
        "",
        "Constraints:",
        "- Work only in the assigned Node/environment and, when shown above, only in the assigned canonical worktree.",
        "- Do not select, create, ensure, inspect, destroy, or otherwise manage Nodes or Node lifecycle unless the verbatim user task explicitly requires that exact action.",
        "- Do not create child sessions unless the verbatim user task explicitly requires that exact action.",
        "- Do not commit, push, restart, or deploy unless the verbatim user task explicitly requires that exact action.",
    ])
    if worktree_path is not None:
        lines.append("- Git metadata is mounted read-only. You may inspect Git metadata/status/diff, but commits and ref/object mutations are unavailable; do not treat the absence of a commit as failure.")
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

    provider_raw = args.get("providerId")
    worktree_raw = args.get("worktreePath")
    if (provider_raw is None) != (worktree_raw is None):
        raise ValueError("providerId and worktreePath must be provided together")
    provider_mode = provider_raw is not None
    provider_id = None
    worktree_path = None
    network_mode = None
    if provider_mode:
        if not isinstance(provider_raw, str) or provider_raw != provider_raw.strip():
            raise ValueError("providerId must be an exact non-empty string")
        provider_id = _provider_id(provider_raw)
        worktree_path = _worktree_path(worktree_raw)
        network_mode = args.get("networkMode", "none")
        if network_mode not in ["none", "bridge"]:
            raise ValueError("networkMode must be none or bridge")
    elif "networkMode" in args:
        raise ValueError("networkMode is valid only when providerId and worktreePath are provided")

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
    node_existed_before = node_id in parsed_listing["nodes"]
    inspected_before = None
    if provider_mode:
        if provider_id not in parsed_listing["providers"] or "ensure" not in parsed_listing["providers"][provider_id]:
            raise ValueError(f"Provider {provider_id} does not advertise node ensure")
        if node_existed_before and dry_run:
            inspected_before = _validate_provider_result(
                _inspect_node(node_id), provider_id, node_id, worktree_path, network_mode, "node inspect"
            )
    elif not node_existed_before:
        raise ValueError(f"Node {node_id} is not currently connected; start/approve it before creating the worker")

    agents = call_tool({"toolId": "builtin:list_agents", "args": {}})
    if not isinstance(agents, str):
        raise ValueError("list_agents returned an unexpected result")
    if _agent_exists(agents, agent_name):
        raise ValueError(f"Agent {agent_name} already exists; choose a unique temporary agent name")
    if inherit_agent is not None and not _agent_exists(agents, inherit_agent):
        raise ValueError(f"Inherited agent {inherit_agent} does not exist")

    session_id = f"{agent_name}/{session_name}"
    handoff = _handoff_message(node_id, task, worktree_path)
    plan = {
        "mode": "provider" if provider_mode else "existing_node",
        "node": {
            "nodeId": node_id,
            "presentInPreflight": node_existed_before,
            "providerId": provider_id,
            "ensureParameters": None if not provider_mode else {
                "worktreePath": worktree_path,
                "networkMode": network_mode,
            },
            "validation": "inspected" if inspected_before is not None else ("planned_ensure" if provider_mode else "listed_online"),
            "canonicalWorktreePath": None if inspected_before is None else inspected_before["details"]["worktreePath"],
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
        "steps": (["ensure_node", "inspect_node"] if provider_mode else []) + ["create_agent", "create_session", "send_to_session"],
        "atomic": False,
        "cleanup": {
            "agent": f"User-confirmed cleanup: /agent delete {agent_name} --confirm",
            "node": _planned_node_cleanup(provider_mode, node_id, node_existed_before),
        },
    }
    if provider_mode:
        plan["node"]["absentBeforeEnsure"] = not node_existed_before

    if dry_run:
        print("validation passed; no node, agent, or session mutation was performed")
        return {"status": "dry_run", "plan": plan, "mutations": []}

    completed = []
    node_ready = not provider_mode
    node_presence_after_ensure = "unknown"
    if provider_mode:
        ensure_result = None
        try:
            ensure_result = call_tool({
                "toolId": "builtin:node",
                "args": {
                    "action": "ensure",
                    "providerId": provider_id,
                    "nodeId": node_id,
                    "parameters": {"worktreePath": worktree_path, "networkMode": network_mode},
                },
            })
            completed.append("ensure_node")
        except Exception as error:
            node_presence_after_ensure = "unknown"
            post_error_validated = False
            try:
                post_error_inspect = _inspect_node(node_id)
                if _raw_exact_node_present(post_error_inspect, node_id):
                    node_presence_after_ensure = "present"
                _validate_provider_result(post_error_inspect, provider_id, node_id, worktree_path, network_mode, "node inspect after ensure error")
                post_error_validated = True
            except Exception:
                post_error_validated = False
            possible_node_mutation = not node_existed_before
            return {
                "status": "partial_failure" if possible_node_mutation else "failed",
                "failedStage": "ensure_node",
                "error": str(error),
                "plan": plan,
                "completedStages": completed,
                "nodeAbsentBeforeEnsure": not node_existed_before,
                "nodePresenceAfterEnsure": node_presence_after_ensure,
                "survivingResources": _node_presence_resources(node_presence_after_ensure, node_id),
                "recovery": _recovery(
                    agent_name, session_id, "ensure_node", True, node_id, node_existed_before,
                    node_presence_after_ensure, post_error_validated, False, False,
                ),
            }
        node_presence_after_ensure = "present" if _raw_exact_node_present(ensure_result, node_id) else "unknown"
        validated_inspect = None
        try:
            inspect_result = _inspect_node(node_id)
            if _raw_exact_node_present(inspect_result, node_id):
                node_presence_after_ensure = "present"
            validated_inspect = _validate_provider_result(inspect_result, provider_id, node_id, worktree_path, network_mode, "node inspect")
            _validate_provider_result(ensure_result, provider_id, node_id, worktree_path, network_mode, "node ensure")
            completed.append("inspect_node")
            node_ready = True
            plan["node"]["validation"] = "ensured_and_inspected"
            plan["node"]["canonicalWorktreePath"] = validated_inspect["details"]["worktreePath"]
        except Exception as error:
            possible_node_mutation = not node_existed_before
            return {
                "status": "partial_failure" if possible_node_mutation else "failed",
                "failedStage": "inspect_node",
                "error": str(error),
                "plan": plan,
                "completedStages": completed,
                "nodeAbsentBeforeEnsure": not node_existed_before,
                "nodePresenceAfterEnsure": node_presence_after_ensure,
                "survivingResources": _node_presence_resources(node_presence_after_ensure, node_id),
                "recovery": _recovery(
                    agent_name, session_id, "inspect_node", True, node_id, node_existed_before,
                    node_presence_after_ensure, validated_inspect is not None, False, False,
                ),
            }

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
        possible_node_mutation = provider_mode and not node_existed_before
        return {
            "status": "partial_failure" if possible_node_mutation or exists_after_error else "failed",
            "failedStage": "create_agent",
            "error": str(error),
            "plan": plan,
            "completedStages": completed,
            "agentDetectedAfterError": exists_after_error,
            "survivingResources": _surviving_resources(True, node_id, exists_after_error, agent_name),
            "recovery": _recovery(
                agent_name, session_id, "create_agent", provider_mode, node_id, node_existed_before,
                "present" if provider_mode else "unknown", node_ready, exists_after_error, False,
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
            "survivingResources": _surviving_resources(True, node_id, True, agent_name),
            "recovery": _recovery(
                agent_name, session_id, "create_session", provider_mode, node_id, node_existed_before,
                "present" if provider_mode else "unknown", node_ready, True, False,
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
            "survivingResources": _surviving_resources(True, node_id, True, agent_name, True, session_id),
            "recovery": _recovery(
                agent_name, session_id, "send_task", provider_mode, node_id, node_existed_before,
                "present" if provider_mode else "unknown", node_ready, True, True,
            ),
        }

    print(f"isolated worker ready: {session_id} on {node_id}")
    result = {
        "status": "completed",
        "mode": plan["mode"],
        "agentName": agent_name,
        "sessionId": session_id,
        "nodeId": node_id,
        "providerId": provider_id,
        "canonicalWorktreePath": worktree_path,
        "networkMode": network_mode,
        "parentSessionId": parent_session_id,
        "completedStages": completed,
        "atomic": False,
        "cleanup": {
            "agent": f"User-confirmed cleanup: /agent delete {agent_name} --confirm",
            "node": _node_cleanup(provider_mode, node_id, node_existed_before, "present" if provider_mode else "unknown", node_ready),
        },
    }
    if provider_mode:
        result["nodeAbsentBeforeEnsure"] = not node_existed_before
        result["nodePresenceAfterEnsure"] = "present"
    return result
