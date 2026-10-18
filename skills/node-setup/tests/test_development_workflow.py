"""Local Git/file fixtures for the public ToolScript; no Foxwarm instance or SSH."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]


def load_script(path, tools):
    spec = importlib.util.spec_from_file_location("development_workflow", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.call_tool = tools
    return module.main


class Tools:
    def __init__(self):
        self.calls = []
        self.fail_copy = None
        self.fail_child = False
        self.pending = False
        self.notification = "sent"
        self.task = None

    def __call__(self, request):
        self.calls.append(request)
        args = request["args"]
        name = request["name"]
        if name == "exec":
            process = subprocess.run(args["command"], shell=True, cwd=args["cwd"], text=True,
                                     capture_output=True, timeout=15)
            output = process.stdout + process.stderr
            if self.pending:
                log = Path(args["cwd"]) / "pending-exec.log"
                log.write_text(output)
                return {"status": "running", "execId": "fixture-exec", "logPath": str(log)}
            return {"status": "completed", "exitCode": process.returncode,
                    "content": output, "truncated": False}
        if name == "read":
            return {"content": Path(args["filePath"]).read_text(), "truncated": False}
        if name == "copy_between_nodes":
            if len([call for call in self.calls if call["name"] == name]) == self.fail_copy:
                raise RuntimeError("fixture transfer failure")
            destination = Path(args["targetPath"])
            with destination.open("xb") as target:
                target.write(Path(args["sourcePath"]).read_bytes())
            return "copied fixture file"
        if name == "task":
            if args["action"] == "create":
                self.task = {"id": "task_fixture", "title": args["title"],
                             "description": args["description"]}
                return {"output": json.dumps({"taskId": self.task["id"], "status": "open",
                                               "ownerSessionId": None, "sentNotifications": 0})}
            return {"output": json.dumps({"task": self.task})}
        if name == "create_child_session":
            if self.fail_child:
                raise RuntimeError("fixture child creation failure")
            self.task.update(ownerSessionId="developer-worker/parser", assignmentNotificationStatus=self.notification)
            return {"output": "native child receipt", "sentNotifications": 1}
        raise AssertionError(request)


class DevelopmentWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="node workflow ' fixture ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git(self.source, "init", "--quiet")
        self.git(self.source, "config", "user.name", "Fixture Developer")
        self.git(self.source, "config", "user.email", "developer@example.invalid")
        (self.source / "file.txt").write_text("base\n")
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "--quiet", "-m", "Base fixture")
        self.base = self.git(self.source, "rev-parse", "HEAD")
        self.bundle = self.root / "source.bundle"
        self.git(self.source, "bundle", "create", str(self.bundle), "HEAD")
        self.worker = self.root / "worker"
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir()
        self.tools = Tools()
        self.main = load_script(SKILL / "examples/development_workflow.py", self.tools)

    def git(self, directory, *args):
        return subprocess.check_output(["git", "-C", str(directory), *args], text=True, stderr=subprocess.PIPE).strip()

    def prepare(self, **extra):
        args = {"phase": "prepare", "sourceNode": "master", "sourceBundle": str(self.bundle),
                "nodeId": "fixture/build", "bundlePath": str(self.root / "input.bundle"),
                "workDir": str(self.worker), "tempDir": str(self.root), "base": self.base,
                "gitIdentity": {"name": "Fixture Worker", "email": "worker@example.invalid"}}
        args.update(extra)
        return self.main(args)

    def snapshot(self):
        return self.main({"phase": "snapshot", "nodeId": "fixture/build", "workDir": str(self.worker),
                          "base": self.base, "tempDir": str(self.root)})

    def receive(self, snapshot, evidence=None):
        return self.main({"phase": "receive", "snapshot": snapshot, "targetNode": "master",
                          "artifactDir": str(self.artifacts), "evidence": evidence or []})

    def test_committed_delivery_reports_dirty_state_without_importing(self):
        prepared = self.prepare()
        self.assertEqual(prepared["status"], "completed", prepared)
        self.assertEqual(self.git(self.worker, "rev-parse", "HEAD"), self.base)
        (self.worker / "file.txt").write_text("committed change\n")
        self.git(self.worker, "commit", "--quiet", "-am", "Change fixture")
        head = self.git(self.worker, "rev-parse", "HEAD")
        (self.worker / "file.txt").write_text("uncommitted change\n")
        (self.worker / "untracked.txt").write_text("untracked\n")
        snapshot = self.snapshot()
        self.assertEqual(snapshot["status"], "completed", snapshot)
        self.assertEqual(snapshot["data"]["commits"], [head])
        self.assertIn("file.txt\0", snapshot["data"]["dirtyStatus"])
        self.assertIn("untracked.txt\0", snapshot["data"]["dirtyStatus"])
        received = self.receive(snapshot)
        self.assertEqual(received["status"], "completed", received)
        self.assertEqual(len(received["transfers"]), 1)
        self.assertEqual(self.git(self.source, "rev-parse", "HEAD"), self.base)
        self.git(self.source, "fetch", str(self.artifacts / "commits.bundle"), "HEAD:refs/heads/review/fixture")
        self.assertEqual(self.git(self.source, "rev-parse", "review/fixture"), head)
        self.assertEqual(self.git(self.source, "show", "review/fixture:file.txt"), "committed change")
        self.assertEqual((self.worker / "file.txt").read_text(), "uncommitted change\n")

    def test_no_new_commits_delivers_evidence_without_fake_bundle(self):
        self.prepare()
        evidence = self.root / "tests.log"
        evidence.write_text("read-only evidence\n")
        snapshot = self.snapshot()
        self.assertEqual(snapshot["data"]["commits"], [])
        self.assertIsNone(snapshot["data"]["bundlePath"])
        received = self.receive(snapshot, [{"path": str(evidence), "name": "tests.log"}])
        self.assertEqual(received["status"], "completed")
        self.assertEqual((self.artifacts / "tests.log").read_text(), evidence.read_text())
        self.assertFalse((self.artifacts / "commits.bundle").exists())
        self.assertEqual(self.git(self.worker, "rev-parse", "HEAD"), self.base)

    def test_partial_transfer_failure_stops_before_exec(self):
        self.tools.fail_copy = 2
        brief = self.root / "brief.md"
        brief.write_text("brief")
        result = self.prepare(materials=[{"sourcePath": str(brief), "targetPath": str(self.root / "worker-brief.md")}])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(len(result["transfers"]), 1)
        self.assertEqual(self.tools.calls[-1]["name"], "copy_between_nodes")
        self.assertFalse(self.worker.exists())

    def test_failed_setup_retains_copy_and_does_not_assign(self):
        self.worker.mkdir()
        result = self.prepare()
        self.assertEqual(result["status"], "failed")
        self.assertNotEqual(result["exec"]["exitCode"], 0)
        self.assertEqual(len(result["transfers"]), 1)
        assigned = self.main({"phase": "assign", "prepared": result, "child": {"suffix": "parser"}})
        self.assertEqual(assigned["status"], "failed")
        self.assertNotIn("task", [call["name"] for call in self.tools.calls])

    def test_pending_setup_collects_without_replaying_exec(self):
        self.tools.pending = True
        result = self.prepare()
        self.assertEqual(result["status"], "pending")
        self.assertEqual(result["exec"]["execId"], "fixture-exec")
        collected = self.main({"phase": "collect", "pending": result, "exitCode": 0})
        self.assertEqual(collected["phase"], "prepare")
        self.assertEqual(collected["status"], "completed", collected)
        self.assertEqual(len([call for call in self.tools.calls if call["name"] == "exec"]), 1)
        failed = self.main({"phase": "collect", "pending": result, "exitCode": 7})
        self.assertEqual(failed["status"], "failed")

    def test_assignment_uses_actual_task_meaningful_name_and_caller_review(self):
        prepared = self.prepare()
        args = {"phase": "assign", "prepared": prepared,
                "task": {"title": "Parser change", "description": "Bounded implementation"},
                "child": {"suffix": "parser", "handoffRecall": "caller-written recall",
                          "handoffConfirmation": "caller-written confirmation"}}
        self.tools.fail_child = True
        failed = self.main(args)
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["taskId"], "task_fixture")
        self.tools.fail_child = False
        result = self.main({**args, "taskId": failed["taskId"]})
        self.assertEqual(result["status"], "completed", result)
        child = [call for call in self.tools.calls if call["name"] == "create_child_session"][-1]["args"]
        self.assertEqual(child["displayName"], "Parser change")
        self.assertEqual(child["taskId"], "task_fixture")
        self.assertEqual(child["node"], "fixture/build")
        self.assertEqual(child["handoffRecall"], "caller-written recall")
        self.assertEqual(list(child)[-1], "handoffConfirmation")
        self.assertNotIn("forceModel", child)
        self.assertEqual(len([call for call in self.tools.calls if call["name"] == "task" and call["args"]["action"] == "create"]), 1)
        self.assertIn(str(self.worker), self.tools.task["description"])

    def test_unconfirmed_assignment_is_not_reported_as_delivered(self):
        self.tools.notification = "failed"
        result = self.main({"phase": "assign", "prepared": self.prepare(),
                            "task": {"title": "Investigate parser", "description": "Read only"},
                            "child": {"suffix": "parser", "displayName": "Parser investigation"}})
        self.assertEqual(result["status"], "needs-verification")
        self.assertEqual(result["childReceipt"]["sentNotifications"], 1)
        child = [call for call in self.tools.calls if call["name"] == "create_child_session"][-1]["args"]
        self.assertEqual(child["displayName"], "Parser investigation")

    def test_delivery_failure_retains_bundle_receipt_and_stops_later_evidence(self):
        self.prepare()
        (self.worker / "file.txt").write_text("committed change\n")
        self.git(self.worker, "commit", "--quiet", "-am", "Change fixture")
        snapshot = self.snapshot()
        received = self.receive(snapshot, [
            {"path": str(self.root / "missing.log"), "name": "missing.log"},
            {"path": str(self.root / "later.log"), "name": "later.log"},
        ])
        self.assertEqual(received["status"], "failed")
        self.assertEqual(len(received["transfers"]), 1)
        self.assertTrue((self.artifacts / "commits.bundle").is_file())
        self.assertFalse((self.artifacts / "later.log").exists())
        self.assertEqual(self.git(self.source, "rev-parse", "HEAD"), self.base)

    def test_installed_skill_needs_no_checkout_for_prepare_or_adapter_describe(self):
        installed = self.root / "installed-skill"
        shutil.copytree(SKILL, installed, ignore=shutil.ignore_patterns("__pycache__"))
        self.main = load_script(installed / "examples/development_workflow.py", self.tools)
        self.assertEqual(self.prepare()["status"], "completed")
        config = self.root / "connections.json"
        config.write_text(json.dumps({"nodes": [{"id": "example", "target": "account@host.example"}]}))
        envelope = {"protocol": "foxwarm-node-provider", "providerId": "fixture", "requestId": "describe-fixture", "operation": "describe"}
        process = subprocess.run(["python3", str(installed / "examples/linux-ssh/provider.py"), "--config", str(config)],
                                 input=json.dumps(envelope), text=True, capture_output=True, cwd=self.root, check=True)
        response = json.loads(process.stdout)
        self.assertTrue(response["ok"])
        self.assertEqual(response["result"]["lifecycle"], [])
        self.assertTrue((installed / "examples/linux-ssh/target.py").is_file())


if __name__ == "__main__":
    unittest.main()
