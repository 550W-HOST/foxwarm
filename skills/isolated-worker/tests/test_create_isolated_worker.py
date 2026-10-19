import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "create_isolated_worker.py"


def load_main(tool_mock):
    spec = importlib.util.spec_from_file_location("create_isolated_worker_under_test", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load ToolScript module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.call_tool = tool_mock
    return module.main


class ToolMock:
    def __init__(self, fail_stage=None, leave_agent_on_create_failure=False,
                 isolated_coordinator=False, listing_override=None, extra_agents=None):
        self.calls = []
        self.fail_stage = fail_stage
        self.leave_agent_on_create_failure = leave_agent_on_create_failure
        self.isolated_coordinator = isolated_coordinator
        self.listing_override = listing_override
        self.extra_agents = extra_agents or []
        self.agent_created = False

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
            if self.listing_override is not None:
                return self.listing_override
            return (
                "Found 2 node(s). Current node: `master`.\n\n"
                "- `master` (local)\n- `worker-node-1` (remote)\n\n"
                "Lifecycle providers:\n- `provider-only` (ensure)\n"
            )
        if tool_id == "builtin:list_agents":
            listing = "Found 2 agent(s):\n\n- **main** (1 session)\n- **base-agent** (1 session)"
            for extra_agent in self.extra_agents:
                listing += f"\n- **{extra_agent}** (0 sessions)"
            if self.agent_created:
                listing += "\n- **tmp-worker-1** [isolated:worker-node-1]"
            return listing
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
        self.assertFalse(result["cleanup"]["node"]["recommendDestroy"])


    def test_provider_only_identifier_is_not_mistaken_for_existing_node(self):
        mock = ToolMock()
        args = self.existing_args(False)
        args["nodeId"] = "provider-only"
        with self.assertRaisesRegex(ValueError, "Node provider-only is not currently connected"):
            load_main(mock)(args)
        self.assertNotIn("builtin:create_agent", self.tool_names(mock))


    def test_malformed_or_ambiguous_node_list_structure_fails_closed(self):
        listings = [
            "Found 1 node(s). Current node: `master`.\n\nLifecycle providers:\n- `fixture-provider` (ensure)\n",
            "Found 2 node(s). Current node: `master`.\n\n- `master` (local)\n- `worker-node-1` (remote)\n\nLifecycle providers:\n- `fixture-provider` (ensure)\nLifecycle providers:\n- `other` (ensure)\n",
        ]
        for listing in listings:
            with self.subTest(listing=listing):
                mock = ToolMock(listing_override=listing)
                with self.assertRaisesRegex(ValueError, "node list"):
                    load_main(mock)(self.existing_args(True))
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


    def test_isolated_coordinator_denied_before_node_or_agent_calls(self):
        mock = ToolMock(isolated_coordinator=True)
        with self.assertRaisesRegex(ValueError, "coordinator session is isolated"):
            load_main(mock)(self.existing_args(False))
        self.assertEqual(self.tool_names(mock), ["builtin:session"])


    def test_argument_bounds_and_actual_node_id_contract(self):
        cases = [
            ("nodeId", "bad/node", "nodeId must be"),
            ("nodeId", " sandbox.dev:1", "must be exact"),
            ("nodeId", "n" * 129, "1-128"),
            ("nodeId", "master", "non-master"),
            ("agentName", "bad.agent", "agentName must use"),
            ("sessionName", "bad/session", "sessionName must use"),
            ("inheritAgent", "bad.agent", "inheritAgent must use"),
            ("task", "   ", "task must be"),
            ("dryRun", "true", "dryRun must be"),
        ]
        for key, value, pattern in cases:
            with self.subTest(key=key, value=value):
                args = self.existing_args(True)
                args[key] = value
                with self.assertRaisesRegex(ValueError, pattern):
                    load_main(ToolMock())(args)

        mismatch_parent = self.existing_args(True)
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

        missing_inherit = self.existing_args(True)
        missing_inherit["inheritAgent"] = "missing-agent"
        with self.assertRaisesRegex(ValueError, "does not exist"):
            load_main(ToolMock())(missing_inherit)


    def test_existing_node_dry_run_does_not_mutate_and_preserves_task(self):
        mock = ToolMock()
        args = self.existing_args(True)
        args["task"] = "Inspect the repository.\n  Preserve the exact task.\n"
        result = load_main(mock)(args)
        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["mutations"], [])
        self.assertEqual(self.tool_names(mock), ["builtin:session", "builtin:node", "builtin:list_agents"])
        self.assertIn(args["task"], result["plan"]["handoff"]["message"])
        self.assertEqual(result["plan"]["worker"]["parentSessionId"], "main")
        self.assertEqual(result["plan"]["worker"]["isolatedNode"], "worker-node-1")

    def test_existing_node_partial_failures_report_only_created_resources(self):
        for stage, leaves_agent, completed, resources in [
            ("create_agent", False, [], {"nodeId": "worker-node-1"}),
            ("create_agent", True, [], {"nodeId": "worker-node-1", "agentName": "tmp-worker-1"}),
            ("create_session", False, ["create_agent"], {"nodeId": "worker-node-1", "agentName": "tmp-worker-1"}),
            ("send_task", False, ["create_agent", "create_session"], {"nodeId": "worker-node-1", "agentName": "tmp-worker-1", "sessionId": "tmp-worker-1/task"}),
        ]:
            with self.subTest(stage=stage, leaves_agent=leaves_agent):
                mock = ToolMock(fail_stage=stage, leave_agent_on_create_failure=leaves_agent)
                result = load_main(mock)(self.existing_args(False))
                self.assertEqual(result["status"], "failed" if stage == "create_agent" and not leaves_agent else "partial_failure")
                self.assertEqual(result["failedStage"], stage)
                self.assertEqual(result["completedStages"], completed)
                self.assertEqual(result["survivingResources"], resources)
                self.assertEqual("agentCleanup" in result["recovery"], "agentName" in resources)
                self.assertEqual("sessionRetry" in result["recovery"], "sessionId" in resources)
                self.assertFalse(result["recovery"]["nodeCleanup"]["recommendDestroy"])


if __name__ == "__main__":
    unittest.main()
