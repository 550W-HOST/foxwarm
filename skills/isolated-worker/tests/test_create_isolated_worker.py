import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "create_isolated_worker.py"
class ToolMock:
    def __init__(self, fail_tool=None, leave_agent_on_create_failure=False):
        self.calls = []
        self.fail_tool = fail_tool
        self.leave_agent_on_create_failure = leave_agent_on_create_failure
        self.agent_created = False

    def __call__(self, descriptor):
        tool_id = descriptor["toolId"]
        args = descriptor.get("args", {})
        self.calls.append((tool_id, args))

        if tool_id == "builtin:session":
            return (
                "📊 *Session Status*\n\n"
                "- session id: `main`\n"
                "- agent id/name: `main`\n"
                "- current node: `master` (connected)\n"
            )
        if tool_id == "builtin:node":
            return "Found 2 node(s). Current node: `master`.\n\n- `master` (local)\n- `worker-node-1` (remote)"
        if tool_id == "builtin:list_agents":
            lines = "Found 1 agent(s):\n\n- **main** (1 session)"
            if self.agent_created:
                lines += "\n- **tmp-worker-1** [isolated:worker-node-1]"
            return lines
        if tool_id == "builtin:create_agent":
            if self.fail_tool == tool_id:
                self.agent_created = self.leave_agent_on_create_failure
                raise RuntimeError("create agent failed")
            self.agent_created = True
            return "Agent created"
        if tool_id == "builtin:create_session":
            if self.fail_tool == tool_id:
                raise RuntimeError("create session failed")
            return 'Session "tmp-worker-1/task" created'
        if tool_id == "builtin:send_to_session":
            if self.fail_tool == tool_id:
                raise RuntimeError("cross-agent isolated deny")
            return "Message sent"
        raise AssertionError(f"Unexpected tool: {tool_id}")


def load_main(tool_mock):
    spec = importlib.util.spec_from_file_location("create_isolated_worker_under_test", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load ToolScript module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.call_tool = tool_mock
    return module.main


class CreateIsolatedWorkerTests(unittest.TestCase):
    def base_args(self, dry_run):
        return {
            "nodeId": "worker-node-1",
            "agentName": "tmp-worker-1",
            "sessionName": "task",
            "task": "Do the task and report to <parent>.",
            "dryRun": dry_run,
        }

    def test_dry_run_is_read_only(self):
        mock = ToolMock()
        result = load_main(mock)(self.base_args(True))

        self.assertEqual(result["status"], "dry_run")
        self.assertEqual(result["plan"]["sessionId"], "tmp-worker-1/task")
        self.assertEqual(
            [tool for tool, _ in mock.calls],
            ["builtin:session", "builtin:node", "builtin:list_agents"],
        )

    def test_apply_calls_existing_tools_in_order(self):
        mock = ToolMock()
        result = load_main(mock)(self.base_args(False))

        self.assertEqual(result["status"], "completed")
        self.assertFalse(result["atomic"])
        self.assertEqual(
            [tool for tool, _ in mock.calls],
            [
                "builtin:session",
                "builtin:node",
                "builtin:list_agents",
                "builtin:create_agent",
                "builtin:create_session",
                "builtin:send_to_session",
            ],
        )
        self.assertEqual(mock.calls[3][1]["isolatedNode"], "worker-node-1")
        self.assertFalse(mock.calls[3][1]["createMainSession"])
        self.assertEqual(mock.calls[4][1]["parentSessionId"], "main")

    def test_send_failure_reports_surviving_resources(self):
        mock = ToolMock(fail_tool="builtin:send_to_session")
        result = load_main(mock)(self.base_args(False))

        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["failedStage"], "send_task")
        self.assertEqual(result["completedStages"], ["create_agent", "create_session"])
        self.assertIn("retry send_to_session", " ".join(result["recovery"]))
        self.assertIn("/agent delete tmp-worker-1 --confirm", " ".join(result["recovery"]))

    def test_create_failure_detects_partial_agent(self):
        mock = ToolMock(
            fail_tool="builtin:create_agent",
            leave_agent_on_create_failure=True,
        )
        result = load_main(mock)(self.base_args(False))

        self.assertEqual(result["status"], "partial_failure")
        self.assertTrue(result["agentDetectedAfterError"])
        self.assertEqual(mock.calls[-1][0], "builtin:list_agents")

    def test_rejects_offline_node_before_mutation(self):
        mock = ToolMock()

        def offline(descriptor):
            if descriptor["toolId"] == "builtin:node":
                mock.calls.append(("builtin:node", {"action": "list"}))
                return (
                    "Found 1 node(s). Current node: `worker-node-1`.\n\n"
                    "- `master` (local)\n\n"
                    "Current node `worker-node-1` is not currently registered/connected."
                )
            return mock(descriptor)

        with self.assertRaisesRegex(ValueError, "not currently connected"):
            load_main(offline)(self.base_args(False))

        self.assertNotIn("builtin:create_agent", [tool for tool, _ in mock.calls])


if __name__ == "__main__":
    unittest.main()
