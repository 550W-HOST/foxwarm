#!/usr/bin/env python3
"""Reference executable Node provider for disposable Docker or Podman containers.

Requires Python 3 and a container engine CLI on the Main host. It keeps no state of its
own: container labels are the inventory, and each Node is one container.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import uuid

PROTOCOL = "foxwarm-node-provider"
LABEL = "net.foxwarm."
# Command records live in the container's own writable layer, so destroy removes them.
STATE_DIR = "/var/tmp/foxwarm-provider"
HELPER = Path(__file__).resolve().parent.parent / "linux-ssh" / "target.py"
SERVICES = {"vscode-fs": 1, "vscode-git": 2, "vscode-pty": 1}
KEEP_ALIVE = ["-c", "import signal; signal.pause()"]
PROFILE_FIELDS = {"image", "description", "user", "workdir", "cpus", "memory", "pids", "runtime", "services"}
PROFILE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
# Core also allows ':' in local IDs; container names do not.
NODE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MEMORY = re.compile(r"^[0-9]+[bkmgBKMG]?$")
DIAGNOSTIC_BYTES = 2000
# The ready line comes from inside the container; Core bounds its own handshake the same way.
READY_LINE_BYTES = 65536
# Engine states in which a container's processes still exist.
LIVE_STATES = {"running", "paused", "restarting"}

DESCRIPTION = (
    "Disposable Linux containers created from administrator-defined profiles. Each Node is one "
    "container with its own workspace. Containers share the host kernel; they are not virtual machines."
)
LIFECYCLE_DESCRIPTION = (
    "create starts a new container from the chosen profile. ensure starts an existing stopped "
    "container, or creates it when missing; it never changes an existing container's profile. "
    "destroy removes the container together with its workspace and command logs."
)
DATA_RETENTION = (
    "Workspace files and command logs stay in the container until destroy deletes them. Copy out "
    "anything you need first. Running commands end when the container stops or is destroyed."
)


class ProviderError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(message):
    raise ProviderError("ConfigurationError", message)


def load_config(path):
    try:
        config = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        fail("The provider configuration file cannot be read as JSON.")
    if not isinstance(config, dict):
        fail("The provider configuration must be a JSON object.")
    unknown = set(config) - {"engine", "engineEnv", "maxNodes", "profiles"}
    if unknown:
        fail("Unsupported configuration fields: " + ", ".join(sorted(unknown)) + ".")
    engine = config.get("engine")
    if (not isinstance(engine, list) or not engine or not all(isinstance(arg, str) and arg for arg in engine)
            or engine[0].startswith("-")):
        fail("engine must be a non-empty array of strings, for example [\"podman\"].")
    environment = config.setdefault("engineEnv", {})
    if not isinstance(environment, dict) or not all(
            isinstance(key, str) and key and "=" not in key and isinstance(value, str)
            for key, value in environment.items()):
        fail("engineEnv must map variable names to strings.")
    limit = config.setdefault("maxNodes", 20)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        fail("maxNodes must be an integer from 1 to 100.")
    profiles = config.get("profiles")
    if not isinstance(profiles, dict) or not profiles:
        fail("profiles must define at least one profile.")
    for name, profile in profiles.items():
        validate_profile(name, profile)
    return config


def validate_profile(name, profile):
    if not PROFILE_NAME.match(name):
        fail("Profile names use letters, digits, dots, underscores and hyphens.")
    if not isinstance(profile, dict):
        fail("Profile " + name + " must be an object.")
    unknown = set(profile) - PROFILE_FIELDS
    if "network" in unknown:
        fail("Profile " + name + ": this adapter always runs containers without a network.")
    if unknown:
        fail("Profile " + name + " has unsupported fields: " + ", ".join(sorted(unknown)) + ".")

    def text(key, required=False):
        value = profile.get(key)
        if value is None and not required:
            return
        if not isinstance(value, str) or not value.strip() or value.startswith("-") or "\n" in value:
            fail("Profile " + name + ": " + key + " must be a non-empty single-line string.")

    text("image", required=True)
    text("user")
    text("runtime")
    if "description" in profile and (not isinstance(profile["description"], str) or "\n" in profile["description"]):
        fail("Profile " + name + ": description must be a single-line string.")
    workdir = profile.setdefault("workdir", "/workspace")
    if not isinstance(workdir, str) or not workdir.startswith("/") or "\n" in workdir or "," in workdir:
        fail("Profile " + name + ": workdir must be an absolute path.")
    cpus = profile.get("cpus")
    if cpus is not None and (isinstance(cpus, bool) or not isinstance(cpus, (int, float)) or cpus <= 0):
        fail("Profile " + name + ": cpus must be a positive number.")
    memory = profile.get("memory")
    if memory is not None and not (isinstance(memory, str) and MEMORY.match(memory)):
        fail("Profile " + name + ": memory must look like \"4g\" or \"512m\".")
    pids = profile.get("pids")
    if pids is not None and (isinstance(pids, bool) or not isinstance(pids, int) or pids < 1):
        fail("Profile " + name + ": pids must be a positive integer.")
    if not isinstance(profile.setdefault("services", False), bool):
        fail("Profile " + name + ": services must be true or false.")


def describe(config):
    text = "Container profile defined by the administrator."
    for name, profile in config["profiles"].items():
        if profile.get("description", "").strip():
            text += " " + name + ": " + profile["description"].strip()
    schema = {
        "type": "object",
        "properties": {"profile": {"type": "string", "enum": list(config["profiles"]), "description": text}},
        "required": ["profile"],
        "additionalProperties": False,
    }
    return {"label": "Containers", "description": DESCRIPTION, "lifecycle": ["create", "ensure", "inspect", "destroy"],
            "createParameters": schema, "ensureParameters": schema,
            "lifecycleDescription": LIFECYCLE_DESCRIPTION, "dataRetention": DATA_RETENTION}


class Engine:
    """Runs the configured engine CLI with argument arrays only."""

    def __init__(self, config):
        self.prefix = list(config["engine"])
        # Core forwards only a small environment allowlist; engine connection settings come from configuration.
        self.environment = dict(os.environ)
        self.environment.update(config["engineEnv"])
        self.children = []

    def start(self, args, **options):
        try:
            child = subprocess.Popen(self.prefix + args, env=self.environment, **options)
        except OSError:
            raise ProviderError("EngineUnavailable", "The container engine command could not be started.")
        self.children.append(child)
        return child

    def run(self, args, stdin=None):
        child = self.start(args, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output, errors = child.communicate(stdin)
        if errors:
            # Administrator diagnostics only; Core never returns provider stderr to callers.
            sys.stderr.write(errors[-DIAGNOSTIC_BYTES:].decode("utf-8", "replace"))
        return child.returncode, output

    def close(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def container_name(provider_id, node_id):
    # The Provider digest keeps two Providers on one engine apart.
    return "foxwarm-" + hashlib.sha256(provider_id.encode()).hexdigest()[:8] + "-" + node_id


def inventory(engine, provider_id, node_id=None):
    filters = ["--filter", "label=" + LABEL + "provider=" + provider_id]
    if node_id is not None:
        filters += ["--filter", "label=" + LABEL + "node=" + node_id]
    for _ in range(2):
        code, output = engine.run(["ps", "-a", "-q", "--no-trunc", *filters])
        if code:
            raise ProviderError("EngineUnavailable", "The container engine did not answer. Check that it is running and reachable.")
        ids = output.decode().split()
        if not ids:
            return []
        code, output = engine.run(["inspect", "--type", "container", *ids])
        if code == 0:
            break
        # A container removed between the two calls fails the whole inspection; list again once.
    else:
        raise ProviderError("EngineUnavailable", "The container engine did not return container details.")
    items = []
    for row in json.loads(output):
        labels = (row.get("Config") or {}).get("Labels") or {}
        if labels.get(LABEL + "provider") != provider_id or (node_id is not None and labels.get(LABEL + "node") != node_id):
            continue
        items.append({
            "node": labels.get(LABEL + "node"),
            "profile": labels.get(LABEL + "profile"),
            "workdir": labels.get(LABEL + "workdir") or "/",
            "image": labels.get(LABEL + "image"),
            "services": labels.get(LABEL + "services") == "true",
            "status": str((row.get("State") or {}).get("Status", "")).lower(),
            "created": row.get("Created"),
            "name": str(row.get("Name", "")).lstrip("/"),
        })
    return [item for item in items if isinstance(item["node"], str) and NODE_ID.match(item["node"])]


def descriptor(item):
    status = item["status"]
    availability = "ready" if status == "running" else "error" if status == "dead" else "offline"
    node = {"id": item["node"], "label": item["node"], "kind": "sandbox", "type": "container",
            "availability": availability, "defaultCwd": item["workdir"], "filesystem": "read-write", "exec": True}
    if item["services"]:
        node["services"] = dict(SERVICES)
    return node


def target(engine, name, operation, request=None):
    """Run the shared Linux target helper inside the container, exactly as the SSH adapter does over SSH."""
    source = HELPER.read_text(encoding="utf-8")
    code = ("_FOXWARM_HELPER_SOURCE = " + repr(source)
            + "\nexec(compile(_FOXWARM_HELPER_SOURCE, '<container-provider>', 'exec'))")
    # "." resolves to the container's working directory, which create sets from the profile.
    payload = {"operation": operation, "request": request or {}, "defaultCwd": ".", "stateDir": STATE_DIR}
    status, output = engine.run(["exec", "-i", name, "python3", "-c", code], stdin=json.dumps(payload).encode())
    if status:
        raise ProviderError("ContainerUnavailable", "The container did not answer. It may be stopped or removed; inspect the Node.")
    try:
        return json.loads(output)
    except ValueError:
        raise ProviderError("ContainerUnavailable", "The container returned an unreadable response.")


def lifecycle_input(config, request, ensure):
    parameters = request.get("parameters") or {}
    if not isinstance(parameters, dict) or set(parameters) - {"profile"}:
        raise ProviderError("InvalidParameters", "Only a profile can be chosen.")
    profile = parameters.get("profile")
    if profile not in config["profiles"]:
        raise ProviderError("InvalidParameters", "Choose one of these profiles: " + ", ".join(config["profiles"]) + ".")
    node_id = request.get("nodeId")
    if node_id is None:
        if ensure:
            raise ProviderError("InvalidRequest", "ensure needs a Node ID.")
        node_id = "c-" + uuid.uuid4().hex[:12]
    if not isinstance(node_id, str) or not NODE_ID.match(node_id):
        raise ProviderError("InvalidNodeId", "Container Node IDs use letters, digits, dots, underscores and hyphens, up to 128 characters.")
    return profile, node_id


def remove(engine, provider_id, node_id):
    for item in inventory(engine, provider_id, node_id):
        engine.run(["rm", "-f", "-v", item["name"]])


def create(engine, config, provider_id, request):
    profile_name, node_id = lifecycle_input(config, request, ensure=False)
    if inventory(engine, provider_id, node_id):
        raise ProviderError("NodeExists", "A container for this Node ID already exists.")
    count = len(inventory(engine, provider_id))
    if count >= config["maxNodes"]:
        raise ProviderError("NodeLimit", "This provider already has its configured maximum of " + str(config["maxNodes"]) + " containers.")
    profile = config["profiles"][profile_name]
    name = container_name(provider_id, node_id)
    labels = {"provider": provider_id, "node": node_id, "profile": profile_name, "workdir": profile["workdir"],
              "image": profile["image"], "services": "true" if profile["services"] else "false"}
    agent = (request.get("context") or {}).get("agent")
    if isinstance(agent, str):
        labels["agent"] = agent
    if isinstance(request.get("sourceSessionId"), str):
        labels["source-session"] = request["sourceSessionId"]
    args = ["run", "-d", "--name", name]
    for key, value in labels.items():
        args += ["--label", LABEL + key + "=" + value]
    args += ["--init", "--restart", "no", "--pull", "never", "--network", "none",
             "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--workdir", profile["workdir"]]
    if profile.get("user"):
        args += ["--user", profile["user"]]
    if profile.get("cpus") is not None:
        args += ["--cpus", str(profile["cpus"])]
    if profile.get("memory"):
        args += ["--memory", profile["memory"]]
    if profile.get("pids") is not None:
        args += ["--pids-limit", str(profile["pids"])]
    if profile.get("runtime"):
        args += ["--runtime", profile["runtime"]]
    args += ["--entrypoint", "python3", profile["image"], *KEEP_ALIVE]
    status, _ = engine.run(args)
    if status:
        # Nothing existed before this request, so a half-created container is ours to remove.
        remove(engine, provider_id, node_id)
        raise ProviderError("CreateFailed", "The container could not be created. Check that the profile's image exists locally and the engine accepts the profile's settings.")
    try:
        probe = target(engine, name, "probe", {"requireExec": True})
    except ProviderError:
        probe = None
    if not probe or not probe.get("ok"):
        remove(engine, provider_id, node_id)
        raise ProviderError("ImageRequirements", "The container started but cannot run commands. Its image needs Python 3, Bash and a working directory writable by the container user.")
    items = inventory(engine, provider_id, node_id)
    if not items:
        raise ProviderError("CreateFailed", "The container disappeared right after it was created.")
    return {"node": descriptor(items[0]), "effect": "Created and started a new container from profile " + profile_name + ".",
            "dataRetention": DATA_RETENTION}


def ensure(engine, config, provider_id, request):
    profile_name, node_id = lifecycle_input(config, request, ensure=True)
    items = inventory(engine, provider_id, node_id)
    if not items:
        return create(engine, config, provider_id, request)
    item = items[0]
    if item["profile"] != profile_name:
        raise ProviderError("ProfileMismatch", "This Node uses profile " + str(item["profile"]) + "; ensure never changes an existing container's profile.")
    effect = "The container was already running."
    if item["status"] == "paused":
        status, _ = engine.run(["unpause", item["name"]])
        if status:
            raise ProviderError("StartFailed", "The paused container could not be resumed.")
        effect = "Resumed the paused container."
        items = inventory(engine, provider_id, node_id)
        if not items:
            raise ProviderError("StartFailed", "The container disappeared while resuming.")
    elif item["status"] != "running":
        status, _ = engine.run(["start", item["name"]])
        if status:
            raise ProviderError("StartFailed", "The existing container could not be started.")
        effect = "Started the existing container. Commands that were running before it stopped have ended."
        items = inventory(engine, provider_id, node_id)
        if not items:
            raise ProviderError("StartFailed", "The container disappeared while starting.")
    return {"node": descriptor(items[0]), "effect": effect, "dataRetention": DATA_RETENTION}


def inspect(engine, provider_id, request):
    items = inventory(engine, provider_id, request.get("nodeId"))
    if not items:
        raise ProviderError("NotFound", "No container exists for this Node.")
    item = items[0]
    details = {"profile": item["profile"], "image": item["image"], "state": item["status"], "createdAt": item["created"],
               "container": item["name"], "network": "none"}
    return {"node": descriptor(item), "dataRetention": DATA_RETENTION, "details": details}


def destroy(engine, provider_id, request):
    node_id = request.get("nodeId")
    items = inventory(engine, provider_id, node_id)
    if not items:
        return {"nodeId": node_id, "effect": "No container existed for this Node."}
    status, _ = engine.run(["rm", "-f", "-v", items[0]["name"]])
    # A container removed concurrently makes rm fail, but the Node is gone all the same.
    if status and inventory(engine, provider_id, node_id):
        raise ProviderError("DestroyFailed", "The container could not be removed.")
    return {"nodeId": node_id, "effect": "Removed the container with its workspace and command logs.",
            "dataRetention": "Nothing from this container remains in the engine except its image."}


def primitive(engine, provider_id, operation, request):
    node_id = request.get("nodeId")
    if not isinstance(node_id, str) or not NODE_ID.match(node_id):
        raise ProviderError("InvalidNodeId", "Unknown Node ID.")
    name = container_name(provider_id, node_id)
    try:
        return target(engine, name, operation, request)
    except ProviderError:
        if operation == "exec-poll":
            items = inventory(engine, provider_id, node_id)
            if not items:
                return {"ok": True, "result": {"state": "lost", "reason": "The container no longer exists."}}
            # Stopping a container ends its processes; they do not come back when it starts again.
            if items[0]["status"] not in LIVE_STATES:
                return {"ok": True, "result": {"state": "lost", "reason": "The container stopped, which ended the command."}}
        raise


def write_line(value):
    sys.stdout.buffer.write(json.dumps(value).encode() + b"\n")
    sys.stdout.buffer.flush()


def connect(engine, provider_id, request, reply):
    """Relay the Code/Terminal service channel to the CLI Node's stdio mode inside the container."""
    node_id = request.get("nodeId")
    items = inventory(engine, provider_id, node_id) if isinstance(node_id, str) else []
    if not items or not items[0]["services"]:
        raise ProviderError("UnsupportedService", "This Node's profile does not offer Code or Terminal.")
    if items[0]["status"] != "running":
        raise ProviderError("ContainerUnavailable", "The container is not running.")
    child = engine.start(["exec", "-i", items[0]["name"], "foxwarm-node", "--stdio"],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        line = child.stdout.readline(READY_LINE_BYTES)
        if not line.endswith(b"\n"):
            raise ValueError()
        ready = json.loads(line)
        if ready.get("type") != "node_stdio_ready" or not isinstance(ready.get("services"), dict):
            raise ValueError()
    except (ValueError, AttributeError):
        raise ProviderError("ServiceUnavailable", "The container's CLI Node did not start its service channel.")
    reply.update(ok=True, result={"nodeId": node_id, "services": ready["services"]})
    write_line(reply)

    def upstream():
        try:
            while True:
                chunk = sys.stdin.buffer.read1(65536)
                if not chunk:
                    break
                child.stdin.write(chunk)
                child.stdin.flush()
        except OSError:
            pass
        finally:
            # Core closing stdin ends the channel; the engine passes EOF on to the CLI Node.
            try:
                child.stdin.close()
            except OSError:
                pass

    threading.Thread(target=upstream, daemon=True).start()
    try:
        while True:
            chunk = child.stdout.read1(65536)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
    except OSError:
        # After confirmation stdout carries frames only; a broken pipe simply ends the channel.
        pass
    child.wait()


def read_envelope():
    first = sys.stdin.buffer.readline()
    try:
        return json.loads(first)
    except ValueError:
        # One-shot requests may span lines; only connect must stay open after its first line.
        return json.loads(first + sys.stdin.buffer.read())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Private JSON profile configuration")
    arguments = parser.parse_args()
    envelope = read_envelope()
    reply = {key: envelope.get(key) for key in ("protocol", "providerId", "requestId", "operation")}
    engine = None
    try:
        if envelope.get("protocol") != PROTOCOL:
            raise ProviderError("UnsupportedProtocol", "Unsupported provider protocol.")
        config = load_config(arguments.config)
        provider_id = envelope.get("providerId")
        if not isinstance(provider_id, str) or not provider_id:
            raise ProviderError("InvalidRequest", "Missing provider ID.")
        operation = envelope.get("operation")
        request = envelope.get("request") or {}
        engine = Engine(config)
        if operation == "describe":
            result = describe(config)
        elif operation == "list":
            result = {"nodes": [descriptor(item) for item in inventory(engine, provider_id)]}
        elif operation == "create":
            result = create(engine, config, provider_id, request)
        elif operation == "ensure":
            result = ensure(engine, config, provider_id, request)
        elif operation == "inspect":
            result = inspect(engine, provider_id, request)
        elif operation == "destroy":
            result = destroy(engine, provider_id, request)
        elif operation in ("filesystem", "exec-start", "exec-poll"):
            response = primitive(engine, provider_id, operation, request)
            if not response.get("ok"):
                reply.update(ok=False, error=response.get("error") or {"code": "TargetError", "message": "The container request failed."})
                write_line(reply)
                return
            result = response["result"]
        elif operation == "connect":
            connect(engine, provider_id, request, reply)
            return
        else:
            raise ProviderError("UnsupportedOperation", "Unsupported operation.")
        reply.update(ok=True, result=result)
    except ProviderError as error:
        reply.update(ok=False, error={"code": error.code, "message": str(error), "retryable": False})
    except Exception:
        # Never return engine arguments, configuration or raw diagnostics to callers.
        reply.update(ok=False, error={"code": "ContainerProviderError", "message": "Provider request failed.", "retryable": False})
    finally:
        if engine is not None:
            engine.close()
    write_line(reply)


def stop_request(_signal, _frame):
    raise SystemExit(1)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop_request)
    main()
