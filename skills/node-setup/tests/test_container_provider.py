"""Container Provider reference adapter against a fake engine CLI; no real engine or Foxwarm instance."""
import base64
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SKILL = Path(__file__).resolve().parents[1]
FAKE = Path(__file__).resolve().with_name("fake_container_engine.py")


class ContainerProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="container provider ' fixture ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.engine = self.root / "engine"
        self.engine.mkdir()
        (self.engine / "images.json").write_text(json.dumps({
            "example/sandbox@sha256:1": {}, "example/no-workdir": {"workdir": False}, "example/no-python": {"python": False}}))
        self.provider = SKILL / "examples/container/provider.py"
        self.configure()

    def configure(self, **changes):
        config = {"engine": [sys.executable, str(FAKE), str(self.engine)], "maxNodes": 3,
                  "profiles": {"offline": {"image": "example/sandbox@sha256:1", "description": "2 CPUs, no network.",
                                           "user": "1000:1000", "cpus": 2, "memory": "4g", "pids": 256},
                               "code": {"image": "example/sandbox@sha256:1", "services": True},
                               "broken": {"image": "example/no-workdir"},
                               "no-python": {"image": "example/no-python"},
                               "missing": {"image": "example/not-built"}}}
        config.update(changes)
        self.config = self.root / "profiles.json"
        self.config.write_text(json.dumps(config))

    def call(self, operation, request=None, provider="sandbox", provider_path=None):
        envelope = {"protocol": "foxwarm-node-provider", "providerId": provider, "requestId": "r-" + operation,
                    "operation": operation}
        if request is not None:
            envelope["request"] = request
        process = subprocess.run([sys.executable, str(provider_path or self.provider), "--config", str(self.config)],
                                 input=json.dumps(envelope), text=True, capture_output=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        response = json.loads(process.stdout)
        for key in ("protocol", "providerId", "requestId", "operation"):
            self.assertEqual(response[key], envelope[key])
        return response

    def ok(self, operation, request=None, **options):
        response = self.call(operation, request, **options)
        self.assertTrue(response["ok"], response)
        return response["result"]

    def error(self, operation, request=None, **options):
        response = self.call(operation, request, **options)
        self.assertFalse(response["ok"], response)
        self.assertFalse(response["error"]["retryable"])
        return response["error"]["code"]

    def calls(self, command=None):
        lines = (self.engine / "calls.jsonl").read_text().splitlines() if (self.engine / "calls.jsonl").exists() else []
        rows = [json.loads(line) for line in lines]
        return [row for row in rows if command is None or row[0] == command]

    def create(self, node="task-1", profile="offline"):
        return self.ok("create", {"sourceSessionId": "coordinator/main", "nodeId": node,
                                  "parameters": {"profile": profile}, "context": {"agent": "coordinator"}})

    def engine_fake(self, *args):
        subprocess.run([sys.executable, str(FAKE), str(self.engine), *args], check=True, capture_output=True)

    def test_describe_offers_only_profiles_with_approved_lifecycle_text(self):
        result = self.ok("describe")
        self.assertEqual(result["label"], "Containers")
        self.assertEqual(result["lifecycle"], ["create", "ensure", "inspect", "destroy"])
        schema = result["createParameters"]
        self.assertEqual(schema, result["ensureParameters"])
        self.assertEqual(list(schema["properties"]), ["profile"])
        self.assertEqual(schema["required"], ["profile"])
        self.assertFalse(schema["additionalProperties"])
        profile = schema["properties"]["profile"]
        self.assertEqual(profile["enum"], ["offline", "code", "broken", "no-python", "missing"])
        self.assertEqual(profile["description"], "Container profile defined by the administrator. offline: 2 CPUs, no network.")
        self.assertIn("dataRetention", result)
        self.assertEqual(self.calls(), [], "describe needs no engine")

    def test_invalid_configuration_is_an_error_response_not_a_crash(self):
        self.configure(profiles={"online": {"image": "example/sandbox@sha256:1", "network": "bridge"}})
        response = self.call("list")
        self.assertEqual(response["error"]["code"], "ConfigurationError")
        self.assertIn("without a network", response["error"]["message"])
        for config in ({"engine": [], "profiles": {"a": {"image": "x"}}},
                       {"engine": ["-x"], "profiles": {"a": {"image": "x"}}},
                       {"engine": ["docker"], "profiles": {"a": {"image": "x", "mounts": ["/:/host"]}}},
                       {"engine": ["docker"], "profiles": {"a": {"image": "x", "memory": "4 gigabytes"}}},
                       {"engine": ["docker"], "maxNodes": 101, "profiles": {"a": {"image": "x"}}},
                       {"engine": ["docker"], "profiles": {}}):
            self.config.write_text(json.dumps(config))
            self.assertEqual(self.error("list"), "ConfigurationError", config)

    def test_create_uses_fixed_hardening_labels_and_profile_limits(self):
        result = self.create()
        node = result["node"]
        self.assertEqual(node, {"id": "task-1", "label": "task-1", "kind": "sandbox", "type": "container",
                                "availability": "ready", "defaultCwd": "/workspace", "filesystem": "read-write",
                                "exec": True, "execEnv": True})
        self.assertIn("offline", result["effect"])
        run = self.calls("run")[0]
        joined = " ".join(run)
        for fragment in ("--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--pull never",
                         "--restart no", "--init", "--user 1000:1000", "--cpus 2", "--memory 4g",
                         "--pids-limit 256", "--workdir /workspace", "--entrypoint python3"):
            self.assertIn(fragment, joined)
        labels = dict(run[index + 1].split("=", 1) for index, arg in enumerate(run) if arg == "--label")
        self.assertEqual(labels["net.foxwarm.provider"], "sandbox")
        self.assertEqual(labels["net.foxwarm.node"], "task-1")
        self.assertEqual(labels["net.foxwarm.profile"], "offline")
        self.assertEqual(labels["net.foxwarm.agent"], "coordinator")
        self.assertEqual(labels["net.foxwarm.source-session"], "coordinator/main")
        self.assertNotIn("-v", run)
        self.assertNotIn("--mount", run)
        self.assertEqual([item["id"] for item in self.ok("list")["nodes"]], ["task-1"])
        self.assertEqual(self.error("create", {"nodeId": "task-1", "parameters": {"profile": "offline"}}), "NodeExists")
        self.assertEqual(len(self.calls("run")), 1)

    def test_model_controls_only_a_configured_profile_and_a_safe_node_id(self):
        for parameters in ({"profile": "offline", "image": "attacker/image"}, {"profile": "unknown"}, {}, ["offline"]):
            self.assertEqual(self.error("create", {"nodeId": "x", "parameters": parameters}), "InvalidParameters")
        for node in ("has:colon", "-flag", "semi;colon", "a" * 129):
            self.assertEqual(self.error("create", {"nodeId": node, "parameters": {"profile": "offline"}}), "InvalidNodeId")
        self.assertEqual(self.calls("run"), [])
        generated = self.ok("create", {"parameters": {"profile": "offline"}})["node"]["id"]
        self.assertTrue(generated.startswith("c-"))
        self.assertEqual(self.error("ensure", {"parameters": {"profile": "offline"}}), "InvalidRequest")

    def test_failed_creation_leaves_no_container(self):
        self.assertEqual(self.error("create", {"nodeId": "a", "parameters": {"profile": "missing"}}), "CreateFailed")
        self.assertEqual(self.error("create", {"nodeId": "b", "parameters": {"profile": "broken"}}), "ImageRequirements")
        self.assertEqual(self.error("create", {"nodeId": "c", "parameters": {"profile": "no-python"}}), "ImageRequirements")
        self.assertEqual(self.ok("list")["nodes"], [])
        self.assertEqual(len(self.calls("rm")), 2)

    def test_ensure_starts_or_reuses_and_never_changes_profile(self):
        self.create()
        runs = len(self.calls("run"))
        self.assertEqual(self.ok("ensure", {"nodeId": "task-1", "parameters": {"profile": "offline"}})["effect"],
                         "The container was already running.")
        self.assertEqual(self.error("ensure", {"nodeId": "task-1", "parameters": {"profile": "code"}}), "ProfileMismatch")
        self.engine_fake("stop", "foxwarm-" + self.digest("sandbox") + "-task-1")
        self.assertEqual(self.ok("list")["nodes"][0]["availability"], "offline")
        result = self.ok("ensure", {"nodeId": "task-1", "parameters": {"profile": "offline"}})
        self.assertEqual(result["node"]["availability"], "ready")
        self.assertIn("Started", result["effect"])
        self.assertEqual(len(self.calls("run")), runs)
        self.assertEqual(len(self.calls("start")), 1)
        self.assertEqual(self.ok("ensure", {"nodeId": "fresh", "parameters": {"profile": "offline"}})["node"]["id"], "fresh")
        self.engine_fake("pause", "foxwarm-" + self.digest("sandbox") + "-task-1")
        listed = {item["id"]: item["availability"] for item in self.ok("list")["nodes"]}
        self.assertEqual(listed, {"task-1": "offline", "fresh": "ready"})
        resumed = self.ok("ensure", {"nodeId": "task-1", "parameters": {"profile": "offline"}})
        self.assertEqual((resumed["node"]["availability"], resumed["effect"]), ("ready", "Resumed the paused container."))
        self.assertEqual(len(self.calls("start")), 1)

    def digest(self, provider):
        import hashlib
        return hashlib.sha256(provider.encode()).hexdigest()[:8]

    def test_node_limit_and_provider_separation_on_one_engine(self):
        for node in ("a", "b", "c"):
            self.create(node)
        self.assertEqual(self.error("create", {"nodeId": "d", "parameters": {"profile": "offline"}}), "NodeLimit")
        other = self.ok("create", {"nodeId": "a", "parameters": {"profile": "offline"}}, provider="other")
        self.assertEqual(other["node"]["id"], "a")
        self.assertEqual(sorted(item["id"] for item in self.ok("list")["nodes"]), ["a", "b", "c"])
        self.assertEqual([item["id"] for item in self.ok("list", provider="other")["nodes"]], ["a"])
        self.ok("destroy", {"nodeId": "a"}, provider="other")
        self.assertEqual(len(self.ok("list")["nodes"]), 3)

    def test_files_and_commands_run_inside_the_container_and_report_loss_after_destroy(self):
        self.create()
        data = "hello ü\n".encode()
        self.ok("filesystem", {"nodeId": "task-1", "operation": "write", "path": "note.txt",
                               "contentBase64": base64.b64encode(data).decode(), "flag": "wx"})
        self.assertEqual(self.ok("filesystem", {"nodeId": "task-1", "operation": "stat", "path": "note.txt"})["size"], len(data))
        read = self.ok("filesystem", {"nodeId": "task-1", "operation": "read", "path": "note.txt", "offset": 0, "count": 100})
        self.assertEqual(base64.b64decode(read["dataBase64"]), data)
        missing = self.call("filesystem", {"nodeId": "task-1", "operation": "stat", "path": "absent"})
        self.assertEqual(missing["error"]["code"], "ENOENT")
        started = self.ok("exec-start", {"nodeId": "task-1", "command": "printf '%s' \"$(cat note.txt)\"; exit 3"})
        self.assertTrue(started["ref"].startswith("process:"))
        self.assertIn("/var/tmp/foxwarm-provider/", started["outputPath"])
        status = self.poll(started["ref"])
        self.assertEqual(status["exitCode"], 3)
        log = self.ok("filesystem", {"nodeId": "task-1", "operation": "read", "path": started["outputPath"], "offset": 0, "count": 100})
        self.assertEqual(base64.b64decode(log["dataBase64"]).decode(), "hello ü")
        name = "foxwarm-" + self.digest("sandbox") + "-task-1"
        self.engine_fake("pause", name)
        # Paused processes still exist, so the command is not reported lost.
        self.assertEqual(self.error("exec-poll", {"nodeId": "task-1", "ref": started["ref"]}), "ContainerUnavailable")
        self.engine_fake("unpause", name)
        self.engine_fake("stop", name)
        stopped = self.ok("exec-poll", {"nodeId": "task-1", "ref": started["ref"]})
        self.assertEqual((stopped["state"], stopped["reason"]), ("lost", "The container stopped, which ended the command."))
        self.assertEqual(self.ok("destroy", {"nodeId": "task-1"})["nodeId"], "task-1")
        lost = self.ok("exec-poll", {"nodeId": "task-1", "ref": started["ref"]})
        self.assertEqual(lost["state"], "lost")
        self.assertEqual(self.ok("destroy", {"nodeId": "task-1"})["effect"], "No container existed for this Node.")
        self.assertEqual(self.error("inspect", {"nodeId": "task-1"}), "NotFound")

    def test_commands_receive_secret_environment_only_in_their_process(self):
        self.create()
        self.assertTrue(self.ok("list")["nodes"][0]["execEnv"])
        value = "synthetic-container-env-0606"
        started = self.ok("exec-start", {"nodeId": "task-1", "command": "printf '%s' \"$CI_TOKEN\" | sha256sum | cut -c1-64",
                                         "env": {"CI_TOKEN": value}})
        self.assertEqual(self.poll(started["ref"])["exitCode"], 0)
        log = self.ok("filesystem", {"nodeId": "task-1", "operation": "read", "path": started["outputPath"], "offset": 0, "count": 100})
        self.assertEqual(base64.b64decode(log["dataBase64"]).decode().strip(), hashlib.sha256(value.encode()).hexdigest())
        # Neither the adapter, the engine nor the target helper wrote the value to a file.
        for path in self.root.rglob("*"):
            if path.is_file():
                self.assertNotIn(value.encode(), path.read_bytes(), str(path))
        refused = self.call("exec-start", {"nodeId": "task-1", "command": "true", "env": {"CI_TOKEN": 1}})
        self.assertEqual(refused["error"]["code"], "InvalidRequest")

    def test_destroy_is_idempotent_when_another_caller_removes_the_container_first(self):
        self.create()
        (self.engine / "rm-fails").write_text("")
        self.assertEqual(self.error("destroy", {"nodeId": "task-1"}), "DestroyFailed")
        self.assertEqual(len(self.ok("list")["nodes"]), 1)
        (self.engine / "rm-fails").unlink()
        (self.engine / "rm-races").write_text("")
        self.assertEqual(self.ok("destroy", {"nodeId": "task-1"})["effect"],
                         "Removed the container with its workspace and command logs.")
        self.assertEqual(self.ok("list")["nodes"], [])

    def poll(self, ref):
        for _ in range(100):
            status = self.ok("exec-poll", {"nodeId": "task-1", "ref": ref})
            if status["state"] != "running":
                return status
            time.sleep(0.05)
        self.fail("command did not finish")

    def test_inspect_reports_profile_and_unreachable_engine_is_never_an_empty_inventory(self):
        self.create()
        details = self.ok("inspect", {"nodeId": "task-1"})["details"]
        self.assertEqual(details["profile"], "offline")
        self.assertEqual(details["image"], "example/sandbox@sha256:1")
        self.assertEqual(details["network"], "none")
        (self.engine / "down").write_text("")
        self.assertEqual(self.error("list"), "EngineUnavailable")
        self.configure(engine=[str(self.root / "no-such-engine")])
        self.assertEqual(self.error("list"), "EngineUnavailable")

    def test_service_channel_relays_the_cli_stdio_mode_until_eof(self):
        self.create("plain")
        self.assertEqual(self.ok("list")["nodes"][0].get("services"), None)
        self.create("editor", profile="code")
        node = [item for item in self.ok("list")["nodes"] if item["id"] == "editor"][0]
        self.assertEqual(node["services"], {"vscode-fs": 1, "vscode-git": 2, "vscode-pty": 1})
        self.assertEqual(self.error("connect", {"nodeId": "plain"}), "UnsupportedService")
        envelope = {"protocol": "foxwarm-node-provider", "providerId": "sandbox", "requestId": "channel",
                    "operation": "connect", "request": {"nodeId": "editor"}}
        frame = {"type": "node_service_request", "requestId": "q1", "service": "vscode-fs", "operation": "stat",
                 "args": {"path": "/workspace"}}
        process = subprocess.Popen([sys.executable, str(self.provider), "--config", str(self.config)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        process.stdin.write(json.dumps(envelope) + "\n")
        process.stdin.flush()
        confirmation = json.loads(process.stdout.readline())
        self.assertTrue(confirmation["ok"], confirmation)
        self.assertEqual(confirmation["requestId"], "channel")
        self.assertEqual(confirmation["result"], {"nodeId": "editor", "services": node["services"]})
        process.stdin.write(json.dumps(frame) + "\n")
        process.stdin.flush()
        self.assertEqual(json.loads(process.stdout.readline()),
                         {"type": "node_service_response", "requestId": "q1", "result": {"echo": frame["args"]}})
        process.stdin.close()
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertEqual(process.stdout.read(), "")
        process.stdout.close()
        self.assertEqual((self.engine / "stdio-ended").read_text(), "eof")

    def test_service_channel_refuses_an_unbounded_ready_line(self):
        self.create("editor", profile="code")
        (self.engine / "stdio-flood").write_text("")
        started = time.monotonic()
        self.assertEqual(self.error("connect", {"nodeId": "editor"}), "ServiceUnavailable")
        self.assertLess(time.monotonic() - started, 20)

    def test_installed_skill_copy_finds_the_shared_target_helper(self):
        installed = self.root / "installed-skill"
        shutil.copytree(SKILL, installed, ignore=shutil.ignore_patterns("__pycache__", "tests"))
        provider = installed / "examples/container/provider.py"
        self.assertEqual(self.ok("create", {"nodeId": "copy", "parameters": {"profile": "offline"}},
                                 provider_path=provider)["node"]["id"], "copy")
        self.assertEqual(self.ok("exec-start", {"nodeId": "copy", "command": "true"}, provider_path=provider)["cwd"][-10:],
                         "/workspace")


if __name__ == "__main__":
    unittest.main()
