import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "create_isolated_worker.py"
EXPECTED_TOOLS = ["read", "write", "edit", "apply_patch", "exec"]
HANDOFF_CONFIRMATION_PREFIX = "Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?"
HANDOFF_REVIEW_PLACEHOLDER = "<replace this with your own non-empty review; do not copy this placeholder verbatim>"
HANDOFF_CONFIRMATION_SUFFIX = "I have completed the check, found no issue, and confirm this inter-agent handoff should proceed."


def load_main(tool_mock):
    spec = importlib.util.spec_from_file_location("create_isolated_worker_under_test", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load ToolScript module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.call_tool = tool_mock
    return module.main


class ToolMock:
    def __init__(
        self,
        provider_node_exists=False,
        provider_actions=None,
        fail_stage=None,
        leave_agent_on_create_failure=False,
        leave_node_on_ensure_failure=False,
        node_overrides=None,
        details_overrides=None,
        isolated_coordinator=False,
        network_mode="none",
        ensure_effect="fixture effect",
        provider_node_id="sandbox.dev:1",
        provider_id="docker-provider",
        listing_override=None,
        extra_agents=None,
    ):
        self.calls = []
        self.provider_node_exists = provider_node_exists
        self.provider_actions = provider_actions or ["create", "ensure", "inspect", "destroy"]
        self.fail_stage = fail_stage
        self.leave_agent_on_create_failure = leave_agent_on_create_failure
        self.leave_node_on_ensure_failure = leave_node_on_ensure_failure
        self.node_overrides = node_overrides or {}
        self.details_overrides = details_overrides or {}
        self.isolated_coordinator = isolated_coordinator
        self.network_mode = network_mode
        self.ensure_effect = ensure_effect
        self.provider_node_id = provider_node_id
        self.provider_id = provider_id
        self.listing_override = listing_override
        self.extra_agents = extra_agents or []
        self.agent_created = False

    def node_result(self):
        node = {
            "id": self.provider_node_id,
            "provider": self.provider_id,
            "kind": "sandbox",
            "type": "docker-worktree",
            "availability": "ready",
            "defaultCwd": "/srv/worktrees/project",
            "tools": [{"name": name} for name in EXPECTED_TOOLS],
        }
        node.update(self.node_overrides)
        details = {
            "worktreePath": "/srv/worktrees/project",
            "networkMode": self.network_mode,
            "status": "running",
            "head": "0123456789abcdef",
            "branch": "testing",
        }
        details.update(self.details_overrides)
        return {
            "node": node,
            "effect": self.ensure_effect,
            "dataRetention": "Git metadata is mounted read-only.",
            "details": details,
        }

    def node_listing(self):
        if self.listing_override is not None:
            return self.listing_override
        node_count = 2 + (1 if self.provider_node_exists else 0)
        lines = [
            f"Found {node_count} node(s). Current node: `master`.",
            "",
            "- `master` (local)",
            "- `worker-node-1` (remote)",
        ]
        if self.provider_node_exists:
            lines.append(f"- `{self.provider_node_id}` (sandbox)")
        lines.extend([
            "",
            "Lifecycle providers:",
            f"- `{self.provider_id}` ({', '.join(self.provider_actions)})",
            "",
        ])
        return "\n".join(lines)

    def __call__(self, descriptor):
        tool_id = descriptor["toolId"]
        args = descriptor.get("args", {})
        self.calls.append((tool_id, args))

        if tool_id == "builtin:session":
            isolated = " (isolated)" if self.isolated_coordinator else ""
            return (
                "Session Status\n"
                "- session id: `main`\n"
                "- agent id/name: `main`\n"
                f"- current node: `master` (ready){isolated}\n"
            )
        if tool_id == "builtin:node" and args.get("action") == "list":
            return self.node_listing()
        if tool_id == "builtin:node" and args.get("action") == "ensure":
            if self.fail_stage == "ensure_node":
                self.provider_node_exists = self.leave_node_on_ensure_failure
                raise RuntimeError("ensure failed")
            self.network_mode = args.get("parameters", {}).get("networkMode", "none")
            self.provider_node_exists = True
            return self.node_result()
        if tool_id == "builtin:node" and args.get("action") == "inspect":
            if self.fail_stage == "inspect_node":
                raise RuntimeError("inspect failed")
            if not self.provider_node_exists:
                raise RuntimeError("node not found")
            return self.node_result()
        if tool_id == "builtin:list_agents":
            lines = "Found 2 agent(s):\n\n- **main** (1 session)\n- **base-agent** (1 session)"
            for extra_agent in self.extra_agents:
                lines += f"\n- **{extra_agent}** (0 sessions)"
            if self.agent_created:
                lines += "\n- **tmp-worker-1** [isolated:sandbox.dev:1]"
            return lines
        if tool_id == "builtin:create_agent":
            if self.fail_stage == "create_agent":
                self.agent_created = self.leave_agent_on_create_failure
                raise RuntimeError("create agent failed")
            self.agent_created = True
            return "Agent created"
        if tool_id == "builtin:create_session":
            if self.fail_stage == "create_session":
                raise RuntimeError("create session failed")
            return 'Session "tmp-worker-1/task" created'
        if tool_id == "builtin:send_to_session":
            if self.fail_stage == "send_task":
                raise RuntimeError("send failed")
            return "Message sent"
        raise AssertionError(f"Unexpected tool: {tool_id} {args}")


class CreateIsolatedWorkerTests(unittest.TestCase):
    def existing_args(self, dry_run=False):
        return {
            "nodeId": "worker-node-1",
            "agentName": "tmp-worker-1",
            "sessionName": "task",
            "task": "Inspect the repository and report.",
            "dryRun": dry_run,
        }

    def provider_args(self, dry_run=False, network_mode=None):
        args = {
            "providerId": "docker-provider",
            "nodeId": "sandbox.dev:1",
            "worktreePath": "/srv/worktrees/project",
            "agentName": "tmp-worker-1",
            "sessionName": "task",
            "task": "Implement the requested change.\nPreserve this line exactly.",
            "inheritAgent": "base-agent",
            "dryRun": dry_run,
        }
        if network_mode is not None:
            args["networkMode"] = network_mode
        return args

    def tool_names(self, mock):
        return [tool for tool, _args in mock.calls]

    def test_existing_node_mode_preserves_original_order_and_no_lifecycle(self):
        mock = ToolMock()
        result = load_main(mock)(self.existing_args(False))

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["mode"], "existing_node")
        self.assertEqual(
            self.tool_names(mock),
            [
                "builtin:session",
                "builtin:node",
                "builtin:list_agents",
                "builtin:create_agent",
                "builtin:create_session",
                "builtin:send_to_session",
            ],
        )
        self.assertNotIn("providerId", mock.calls[1][1])
        self.assertFalse(result["cleanup"]["node"]["recommendDestroy"])

    def test_provider_only_identifier_is_not_mistaken_for_existing_node(self):
        mock = ToolMock(provider_node_exists=False, provider_id="provider-only")
        args = self.existing_args(False)
        args["nodeId"] = "provider-only"
        with self.assertRaisesRegex(ValueError, "Node provider-only is not currently connected"):
            load_main(mock)(args)
        self.assertNotIn("builtin:create_agent", self.tool_names(mock))

    def test_node_and_provider_may_share_exact_identifier_without_section_confusion(self):
        mock = ToolMock(provider_node_exists=True, provider_node_id="shared-id", provider_id="shared-id")
        args = self.provider_args(True)
        args["nodeId"] = "shared-id"
        args["providerId"] = "shared-id"
        result = load_main(mock)(args)

        self.assertEqual(result["status"], "dry_run")
        self.assertTrue(result["plan"]["node"]["presentInPreflight"])
        self.assertFalse(result["plan"]["node"]["absentBeforeEnsure"])
        self.assertEqual(mock.calls[2][1], {"action": "inspect", "nodeId": "shared-id"})

    def test_malformed_or_ambiguous_node_list_structure_fails_closed(self):
        listings = [
            "Found 1 node(s). Current node: `master`.\n\nLifecycle providers:\n- `docker-provider` (ensure)\n",
            "Found 2 node(s). Current node: `master`.\n\n- `master` (local)\n- `worker-node-1` (remote)\n\nLifecycle providers:\n- `docker-provider` (ensure)\nLifecycle providers:\n- `other` (ensure)\n",
        ]
        for listing in listings:
            with self.subTest(listing=listing):
                mock = ToolMock(listing_override=listing)
                with self.assertRaisesRegex(ValueError, "node list"):
                    load_main(mock)(self.provider_args(True))
                self.assertNotIn("builtin:create_agent", self.tool_names(mock))

    def test_existing_mode_preserves_long_safe_agent_session_and_inherit_names(self):
        agent_name = "a" * 65
        session_name = "s" * 65
        inherit_name = "i" * 65
        mock = ToolMock(extra_agents=[inherit_name])
        args = self.existing_args(False)
        args["agentName"] = agent_name
        args["sessionName"] = session_name
        args["inheritAgent"] = inherit_name
        result = load_main(mock)(args)

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["sessionId"], f"{agent_name}/{session_name}")
        self.assertEqual(mock.calls[3][1]["inherit"], inherit_name)

    def test_provider_dry_run_absent_is_read_only_and_truthful(self):
        mock = ToolMock(provider_node_exists=False)
        result = load_main(mock)(self.provider_args(True))

        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["mutations"], [])
        self.assertEqual(self.tool_names(mock), ["builtin:session", "builtin:node", "builtin:list_agents"])
        node = result["plan"]["node"]
        self.assertFalse(node["presentInPreflight"])
        self.assertTrue(node["absentBeforeEnsure"])
        self.assertEqual(node["validation"], "planned_ensure")
        self.assertIsNone(node["canonicalWorktreePath"])
        self.assertEqual(node["ensureParameters"], {"worktreePath": "/srv/worktrees/project", "networkMode": "none"})

    def test_provider_dry_run_existing_inspects_exact_node(self):
        mock = ToolMock(provider_node_exists=True, network_mode="bridge")
        result = load_main(mock)(self.provider_args(True, "bridge"))

        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(self.tool_names(mock), ["builtin:session", "builtin:node", "builtin:node", "builtin:list_agents"])
        self.assertEqual(mock.calls[2][1], {"action": "inspect", "nodeId": "sandbox.dev:1"})
        self.assertTrue(result["plan"]["node"]["presentInPreflight"])
        self.assertFalse(result["plan"]["node"]["absentBeforeEnsure"])
        self.assertEqual(result["plan"]["node"]["validation"], "inspected")
        self.assertEqual(result["plan"]["node"]["canonicalWorktreePath"], "/srv/worktrees/project")

    def test_provider_requires_ensure_and_all_or_nothing_arguments(self):
        mock = ToolMock(provider_actions=["inspect", "destroy"])
        with self.assertRaisesRegex(ValueError, "does not advertise node ensure"):
            load_main(mock)(self.provider_args(True))
        self.assertNotIn("builtin:create_agent", self.tool_names(mock))

        invalid = [
            ({"providerId": "docker-provider"}, "provided together"),
            ({"worktreePath": "/srv/worktrees/project"}, "provided together"),
            ({"networkMode": "none"}, "valid only"),
        ]
        for additions, pattern in invalid:
            with self.subTest(additions=additions):
                args = self.existing_args(True)
                args.update(additions)
                with self.assertRaisesRegex(ValueError, pattern):
                    load_main(ToolMock())(args)

    def test_descriptor_worktree_network_and_provider_mismatches_stop_before_agent(self):
        cases = [
            ({"provider": "other-provider"}, {}, "provider mismatch"),
            ({"kind": "remote"}, {}, "kind mismatch"),
            ({"type": "other"}, {}, "type mismatch"),
            ({"availability": "offline"}, {}, "availability mismatch"),
            ({"defaultCwd": "/other"}, {}, "defaultCwd mismatch"),
            ({}, {"worktreePath": "/other"}, "worktreePath mismatch"),
            ({}, {"networkMode": "bridge"}, "networkMode mismatch"),
        ]
        for node_overrides, details_overrides, pattern in cases:
            with self.subTest(pattern=pattern):
                mock = ToolMock(
                    provider_node_exists=True,
                    node_overrides=node_overrides,
                    details_overrides=details_overrides,
                )
                with self.assertRaisesRegex(ValueError, pattern):
                    load_main(mock)(self.provider_args(True))
                self.assertNotIn("builtin:create_agent", self.tool_names(mock))

    def test_real_provider_run_ensures_inspects_then_creates_and_hands_off_complete_context(self):
        mock = ToolMock(provider_node_exists=False)
        result = load_main(mock)(self.provider_args(False, "bridge"))

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["providerId"], "docker-provider")
        self.assertEqual(result["canonicalWorktreePath"], "/srv/worktrees/project")
        self.assertEqual(result["networkMode"], "bridge")
        self.assertTrue(result["nodeAbsentBeforeEnsure"])
        self.assertEqual(result["nodePresenceAfterEnsure"], "present")
        self.assertNotIn("nodeNewlyEnsuredByRun", result)
        self.assertEqual(result["completedStages"], ["ensure_node", "inspect_node", "create_agent", "create_session", "send_to_session"])
        self.assertEqual(
            self.tool_names(mock),
            [
                "builtin:session",
                "builtin:node",
                "builtin:list_agents",
                "builtin:node",
                "builtin:node",
                "builtin:create_agent",
                "builtin:create_session",
                "builtin:send_to_session",
            ],
        )
        ensure = mock.calls[3][1]
        self.assertEqual(ensure, {
            "action": "ensure",
            "providerId": "docker-provider",
            "nodeId": "sandbox.dev:1",
            "parameters": {"worktreePath": "/srv/worktrees/project", "networkMode": "bridge"},
        })
        self.assertEqual(mock.calls[4][1], {"action": "inspect", "nodeId": "sandbox.dev:1"})
        self.assertEqual(mock.calls[5][1]["isolatedNode"], "sandbox.dev:1")
        self.assertFalse(mock.calls[5][1]["createMainSession"])
        self.assertEqual(mock.calls[5][1]["inherit"], "base-agent")
        self.assertEqual(mock.calls[6][1]["parentSessionId"], "main")

        send_args = mock.calls[7][1]
        self.assertEqual(list(send_args.keys())[-1], "confirmation")
        confirmation_lines = send_args["confirmation"].split("\n")
        self.assertEqual(confirmation_lines[0], HANDOFF_CONFIRMATION_PREFIX)
        self.assertTrue(confirmation_lines[1].strip())
        self.assertEqual(confirmation_lines[-1], HANDOFF_CONFIRMATION_SUFFIX)

        handoff = send_args["message"]
        self.assertIn("Assigned Node: `sandbox.dev:1`", handoff)
        self.assertIn("Assigned canonical worktree: `/srv/worktrees/project`", handoff)
        self.assertIn("Implement the requested change.\nPreserve this line exactly.", handoff)
        self.assertIn("Work only in the assigned Node/environment", handoff)
        self.assertIn("Do not select, create, ensure, inspect, destroy", handoff)
        self.assertIn("Do not create child sessions", handoff)
        self.assertIn("Do not commit, push, restart, or deploy unless", handoff)
        self.assertIn("Git metadata is mounted read-only", handoff)
        self.assertIn('send_to_session({sessionId: "<parent>", message: "...", afterSend: "finish", confirmation: "', handoff)
        self.assertIn(HANDOFF_CONFIRMATION_PREFIX, handoff)
        self.assertIn(HANDOFF_CONFIRMATION_SUFFIX, handoff)
        self.assertIn(HANDOFF_REVIEW_PLACEHOLDER, handoff)
        self.assertIn("current tool schema requires confirmation", handoff)
        self.assertIn("the property may be omitted", handoff)
        self.assertIn("changed files and a diff summary", handoff)
        self.assertIn("validation commands/results", handoff)
        self.assertIn("blockers or unresolved questions", handoff)
        self.assertIn("Do not assume or claim that a commit exists", handoff)
        for leaked in ["continue autonomously", "complete all phases", "when to pause", "ask the user"]:
            self.assertNotIn(leaked, handoff.lower())

    def test_real_mismatch_after_ensure_stops_before_agent_mutation(self):
        mock = ToolMock(provider_node_exists=False, details_overrides={"networkMode": "bridge"})
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["failedStage"], "inspect_node")
        self.assertEqual(result["completedStages"], ["ensure_node"])
        self.assertNotIn("builtin:create_agent", self.tool_names(mock))
        self.assertEqual(result["survivingResources"]["nodeId"], "sandbox.dev:1")
        self.assertNotIn("agentCleanup", result["recovery"])
        self.assertIn("agent and session were not created", " ".join(result["recovery"]["notes"]))

    def test_preexisting_provider_node_inspect_failure_is_failed_without_agent_cleanup(self):
        mock = ToolMock(provider_node_exists=True, fail_stage="inspect_node")
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failedStage"], "inspect_node")
        self.assertEqual(result["completedStages"], ["ensure_node"])
        self.assertEqual(result["survivingResources"], {"nodeId": "sandbox.dev:1"})
        self.assertFalse(result["nodeAbsentBeforeEnsure"])
        self.assertEqual(result["nodePresenceAfterEnsure"], "present")
        self.assertNotIn("agentCleanup", result["recovery"])
        self.assertIn("agent and session were not created", " ".join(result["recovery"]["notes"]))
        self.assertNotIn("optionalCoordinatorCleanup", result["recovery"]["nodeCleanup"])

    def test_preexisting_node_create_agent_failure_without_partial_agent_is_failed(self):
        mock = ToolMock(provider_node_exists=True, fail_stage="create_agent")
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["agentDetectedAfterError"])
        self.assertEqual(result["survivingResources"], {"nodeId": "sandbox.dev:1"})
        self.assertNotIn("agentCleanup", result["recovery"])
        self.assertIn("agent was not detected", " ".join(result["recovery"]["notes"]))
        self.assertIn("no worker session was created", " ".join(result["recovery"]["notes"]))

    def test_absent_node_ensure_failure_with_inspect_error_reports_unknown_possible_survivor(self):
        mock = ToolMock(provider_node_exists=False, fail_stage="ensure_node")
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["nodePresenceAfterEnsure"], "unknown")
        self.assertEqual(result["survivingResources"], {"possibleNodeId": "sandbox.dev:1"})
        self.assertNotIn("agentCleanup", result["recovery"])
        self.assertIn("agent and session were not created", " ".join(result["recovery"]["notes"]))
        self.assertIn("state after ensure is unconfirmed", result["recovery"]["nodeCleanup"]["note"])

    def test_ensure_error_with_exact_raw_node_but_full_mismatch_reports_definite_survivor(self):
        mock = ToolMock(
            provider_node_exists=False,
            fail_stage="ensure_node",
            leave_node_on_ensure_failure=True,
            details_overrides={"networkMode": "bridge"},
        )
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["nodePresenceAfterEnsure"], "present")
        self.assertEqual(result["survivingResources"], {"nodeId": "sandbox.dev:1"})
        self.assertNotIn("agentCleanup", result["recovery"])
        self.assertIn("raw post-error inspect proves exact Node", " ".join(result["recovery"]["notes"]))
        self.assertIn("exact inspect validation did not complete", result["recovery"]["nodeCleanup"]["note"])

    def test_preflight_present_and_absent_node_cleanup_truth_are_distinct_without_ownership(self):
        existing = ToolMock(provider_node_exists=True, fail_stage="create_session")
        existing_result = load_main(existing)(self.provider_args(False))
        self.assertFalse(existing_result["recovery"]["nodeCleanup"]["recommendDestroy"])
        self.assertNotIn("optionalCoordinatorCleanup", existing_result["recovery"]["nodeCleanup"])
        self.assertIn("existed before", existing_result["recovery"]["nodeCleanup"]["note"])

        absent = ToolMock(provider_node_exists=False, fail_stage="create_session")
        absent_result = load_main(absent)(self.provider_args(False))
        cleanup = absent_result["recovery"]["nodeCleanup"]
        self.assertFalse(cleanup["automatic"])
        self.assertFalse(cleanup["recommendDestroy"])
        self.assertNotIn("optionalCoordinatorCleanup", cleanup)
        self.assertIn("does not prove", cleanup["note"])
        self.assertIn("no lease", cleanup["note"])
        self.assertIn("retain it by default", cleanup["note"].lower())
        self.assertIn("/agent delete tmp-worker-1 --confirm", absent_result["recovery"]["agentCleanup"])

    def test_preflight_absence_then_existing_ensure_result_never_claims_ownership_or_offers_destroy(self):
        mock = ToolMock(provider_node_exists=False, ensure_effect="already existed after concurrent ensure")
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["nodeAbsentBeforeEnsure"])
        self.assertEqual(result["nodePresenceAfterEnsure"], "present")
        self.assertNotIn("nodeNewlyEnsuredByRun", result)
        cleanup = result["cleanup"]["node"]
        self.assertFalse(cleanup["automatic"])
        self.assertFalse(cleanup["recommendDestroy"])
        self.assertNotIn("optionalCoordinatorCleanup", cleanup)
        self.assertIn("does not prove", cleanup["note"])
        self.assertIn("no lease", cleanup["note"])
        self.assertIn("independent operator/workflow confirmation", cleanup["note"])

    def test_all_partial_failure_stages_report_surviving_resources(self):
        cases = [
            ("ensure_node", False, "ensure_node", []),
            ("inspect_node", False, "inspect_node", ["ensure_node"]),
            ("create_agent", False, "create_agent", ["ensure_node", "inspect_node"]),
            ("create_session", False, "create_session", ["ensure_node", "inspect_node", "create_agent"]),
            ("send_task", False, "send_task", ["ensure_node", "inspect_node", "create_agent", "create_session"]),
        ]
        for fail_stage, leave_node, expected_stage, completed in cases:
            with self.subTest(fail_stage=fail_stage):
                mock = ToolMock(
                    provider_node_exists=False,
                    fail_stage=fail_stage,
                    leave_node_on_ensure_failure=leave_node,
                )
                result = load_main(mock)(self.provider_args(False))
                self.assertEqual(result["failedStage"], expected_stage)
                self.assertEqual(result["completedStages"], completed)
                self.assertIn("recovery", result)
                if fail_stage in ["ensure_node", "inspect_node"]:
                    self.assertNotIn("builtin:create_agent", self.tool_names(mock))

    def test_each_failure_stage_has_exact_cleanup_scope(self):
        ensure = load_main(ToolMock(provider_node_exists=False, fail_stage="ensure_node"))(self.provider_args(False))
        self.assertNotIn("agentCleanup", ensure["recovery"])
        self.assertNotIn("sessionRetry", ensure["recovery"])
        self.assertEqual(ensure["survivingResources"], {"possibleNodeId": "sandbox.dev:1"})

        inspect = load_main(ToolMock(provider_node_exists=False, fail_stage="inspect_node"))(self.provider_args(False))
        self.assertEqual(inspect["status"], "partial_failure")
        self.assertEqual(inspect["nodePresenceAfterEnsure"], "present")
        self.assertNotIn("agentCleanup", inspect["recovery"])
        self.assertNotIn("sessionRetry", inspect["recovery"])
        self.assertEqual(inspect["survivingResources"], {"nodeId": "sandbox.dev:1"})

        create_agent = load_main(ToolMock(provider_node_exists=False, fail_stage="create_agent"))(self.provider_args(False))
        self.assertEqual(create_agent["status"], "partial_failure")
        self.assertNotIn("agentCleanup", create_agent["recovery"])
        self.assertNotIn("sessionRetry", create_agent["recovery"])
        self.assertEqual(create_agent["survivingResources"], {"nodeId": "sandbox.dev:1"})

        create_session = load_main(ToolMock(provider_node_exists=False, fail_stage="create_session"))(self.provider_args(False))
        self.assertIn("agentCleanup", create_session["recovery"])
        self.assertNotIn("sessionRetry", create_session["recovery"])
        self.assertEqual(create_session["survivingResources"], {
            "nodeId": "sandbox.dev:1",
            "agentName": "tmp-worker-1",
        })
        self.assertIn("session was not created", " ".join(create_session["recovery"]["notes"]))

        send = load_main(ToolMock(provider_node_exists=False, fail_stage="send_task"))(self.provider_args(False))
        self.assertIn("agentCleanup", send["recovery"])
        self.assertIn("sessionRetry", send["recovery"])
        self.assertEqual(send["survivingResources"], {
            "nodeId": "sandbox.dev:1",
            "agentName": "tmp-worker-1",
            "sessionId": "tmp-worker-1/task",
        })
        self.assertIn("retry send_to_session", " ".join(send["recovery"]["notes"]))

    def test_ensure_failure_that_left_exact_new_node_is_truthful_partial(self):
        mock = ToolMock(
            provider_node_exists=False,
            fail_stage="ensure_node",
            leave_node_on_ensure_failure=True,
        )
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["nodePresenceAfterEnsure"], "present")
        self.assertEqual(result["survivingResources"]["nodeId"], "sandbox.dev:1")
        self.assertNotIn("optionalCoordinatorCleanup", result["recovery"]["nodeCleanup"])
        self.assertIn("does not prove", result["recovery"]["nodeCleanup"]["note"])

    def test_create_agent_failure_rechecks_for_partial_agent(self):
        mock = ToolMock(
            provider_node_exists=False,
            fail_stage="create_agent",
            leave_agent_on_create_failure=True,
        )
        result = load_main(mock)(self.provider_args(False))

        self.assertEqual(result["status"], "partial_failure")
        self.assertTrue(result["agentDetectedAfterError"])
        self.assertEqual(mock.calls[-1][0], "builtin:list_agents")
        self.assertIn("/agent delete tmp-worker-1 --confirm", result["recovery"]["agentCleanup"])

    def test_isolated_coordinator_denied_before_node_or_agent_calls(self):
        mock = ToolMock(isolated_coordinator=True)
        with self.assertRaisesRegex(ValueError, "coordinator session is isolated"):
            load_main(mock)(self.provider_args(False))
        self.assertEqual(self.tool_names(mock), ["builtin:session"])

    def test_argument_bounds_and_actual_node_id_contract(self):
        valid = ToolMock(provider_node_exists=False)
        result = load_main(valid)(self.provider_args(True))
        self.assertEqual(result["plan"]["node"]["nodeId"], "sandbox.dev:1")

        cases = [
            ("nodeId", "bad/node", "nodeId must be"),
            ("nodeId", " sandbox.dev:1", "must be exact"),
            ("nodeId", "n" * 129, "1-128"),
            ("nodeId", "master", "non-master"),
            ("providerId", "bad:provider", "providerId must be"),
            ("providerId", "docker-provider ", "exact non-empty"),
            ("providerId", "p" * 65, "1-64"),
            ("worktreePath", "relative/path", "absolute path"),
            ("worktreePath", "/srv//project", "lexically canonical"),
            ("worktreePath", "/srv/project/", "trailing slash"),
            ("worktreePath", "/srv/project,other", "commas"),
            ("networkMode", "host", "none or bridge"),
            ("agentName", "bad.agent", "agentName must use"),
            ("sessionName", "bad/session", "sessionName must use"),
            ("inheritAgent", "bad.agent", "inheritAgent must use"),
            ("task", "   ", "task must be"),
            ("dryRun", "true", "dryRun must be"),
        ]
        for key, value, pattern in cases:
            with self.subTest(key=key, value=value):
                args = self.provider_args(True)
                args[key] = value
                with self.assertRaisesRegex(ValueError, pattern):
                    load_main(ToolMock())(args)

        mismatch_parent = self.provider_args(True)
        mismatch_parent["parentSessionId"] = "other"
        mock = ToolMock()
        with self.assertRaisesRegex(ValueError, "must match the current"):
            load_main(mock)(mismatch_parent)
        self.assertEqual(self.tool_names(mock), ["builtin:session"])

    def test_unique_agent_and_inheritance_validation_remain_read_only(self):
        existing_agent = ToolMock()
        existing_agent.agent_created = True
        with self.assertRaisesRegex(ValueError, "already exists"):
            load_main(existing_agent)(self.existing_args(True))
        self.assertNotIn("builtin:create_agent", self.tool_names(existing_agent))

        missing_inherit = self.provider_args(True)
        missing_inherit["inheritAgent"] = "missing-agent"
        with self.assertRaisesRegex(ValueError, "does not exist"):
            load_main(ToolMock())(missing_inherit)


if __name__ == "__main__":
    unittest.main()
