#!/usr/bin/env python3
"""Minimal Docker/Podman CLI stand-in for container Provider tests.

Usage: fake_container_engine.py STATE_ROOT <engine arguments>. Containers are directories
under STATE_ROOT; `exec` runs the requested command locally with the container's
filesystem directory as its root for the working and state directories. It is not a sandbox.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(sys.argv[1])
ARGS = sys.argv[2:]
CONTAINERS = ROOT / "containers"


def log():
    with open(ROOT / "calls.jsonl", "a", encoding="utf-8") as stream:
        # The helper source is long; record only that an exec carried code.
        stream.write(json.dumps([arg if len(arg) < 300 else "<code>" for arg in ARGS]) + "\n")


def containers():
    CONTAINERS.mkdir(parents=True, exist_ok=True)
    return [json.loads((path / "meta.json").read_text()) for path in sorted(CONTAINERS.iterdir())]


def find(reference):
    for item in containers():
        if reference in (item["Id"], item["Name"].lstrip("/")):
            return item
    return None


def save(item):
    (CONTAINERS / item["Id"] / "meta.json").write_text(json.dumps(item))


def fs(item):
    return CONTAINERS / item["Id"] / "fs"


def fail(message, code=1):
    sys.stderr.write(message + "\n")
    sys.exit(code)


def ps(args):
    filters = [args[index + 1] for index, arg in enumerate(args) if arg == "--filter"]
    for item in containers():
        labels = item["Config"]["Labels"]
        wanted = [value[len("label="):].split("=", 1) for value in filters]
        if all(labels.get(key) == value for key, value in wanted):
            print(item["Id"])


def inspect(references):
    rows, missing = [], False
    for reference in references:
        item = find(reference)
        if item is None:
            missing = True
        else:
            rows.append(item)
    print(json.dumps(rows))
    if missing:
        fail("Error: No such container")


def run(args):
    options = {"--label": []}
    index = 0
    flags = {"-d", "--init"}
    while args[index].startswith("-"):
        if args[index] in flags:
            options[args[index]] = True
            index += 1
            continue
        key, value = args[index], args[index + 1]
        if key == "--label":
            options["--label"].append(value)
        else:
            options[key] = value
        index += 2
    image, command = args[index], args[index + 1:]
    images = json.loads((ROOT / "images.json").read_text())
    if image not in images:
        fail("Error: image not known locally and pulling is disabled", 125)
    if find(options["--name"]) is not None:
        fail("Error: container name already in use", 125)
    identifier = uuid.uuid4().hex
    item = {"Id": identifier, "Name": "/" + options["--name"], "Created": datetime.now(timezone.utc).isoformat(),
            "State": {"Status": "running"},
            "Config": {"Labels": dict(label.split("=", 1) for label in options["--label"]), "Image": image,
                       "WorkingDir": options["--workdir"], "User": options.get("--user", ""),
                       "Entrypoint": [options["--entrypoint"]], "Cmd": command},
            "Image": images[image]}
    (CONTAINERS / identifier).mkdir(parents=True)
    root = fs(item)
    root.mkdir()
    if images[image].get("workdir", True):
        (root / options["--workdir"].lstrip("/")).mkdir(parents=True)
    save(item)
    print(identifier)


def execute(args):
    interactive = args[0] == "-i"
    if interactive:
        args = args[1:]
    item = find(args[0])
    if item is None:
        fail("Error: No such container", 1)
    if item["State"]["Status"] != "running":
        fail("Error: container is not running", 126)
    command = args[1:]
    if command[:2] == ["foxwarm-node", "--stdio"]:
        return stdio_node()
    if not item["Image"].get("python", True):
        fail("exec: python3: not found", 127)
    payload = json.loads(sys.stdin.buffer.read())
    root = fs(item)
    payload["stateDir"] = str(root) + payload["stateDir"]
    workdir = root / item["Config"]["WorkingDir"].lstrip("/")
    if not workdir.is_dir():
        fail("OCI runtime exec failed: chdir to working directory", 126)
    process = subprocess.run([sys.executable, *command[1:]], input=json.dumps(payload).encode(),
                             cwd=workdir, stdout=subprocess.PIPE)
    sys.stdout.buffer.write(process.stdout)
    sys.exit(process.returncode)


def stdio_node():
    if (ROOT / "stdio-flood").exists():
        # A workload-controlled line without an end.
        sys.stdout.write("x" * 70000)
        sys.stdout.flush()
        sys.stdin.read()
        return
    print(json.dumps({"type": "node_stdio_ready", "services": {"vscode-fs": 1, "vscode-git": 2, "vscode-pty": 1}}), flush=True)
    for line in sys.stdin:
        frame = json.loads(line)
        if frame.get("type") == "node_service_request":
            reply = {"type": "node_service_response", "requestId": frame["requestId"], "result": {"echo": frame["args"]}}
            print(json.dumps(reply), flush=True)
    (ROOT / "stdio-ended").write_text("eof")


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    log()
    if (ROOT / "down").exists():
        fail("Cannot connect to the container engine.")
    command, rest = ARGS[0], ARGS[1:]
    if command == "ps":
        ps(rest)
    elif command == "inspect":
        inspect([arg for arg in rest if arg not in ("--type", "container")])
    elif command == "run":
        run(rest)
    elif command == "exec":
        execute(rest)
    elif command in ("start", "stop", "pause", "unpause"):
        item = find(rest[0]) or fail("Error: No such container")
        if command == "start" and item["State"]["Status"] == "paused":
            fail("Error: cannot start a paused container, try unpause instead")
        item["State"]["Status"] = {"start": "running", "stop": "exited", "pause": "paused", "unpause": "running"}[command]
        save(item)
        print(rest[0])
    elif command == "rm":
        item = find(rest[-1])
        if item is None:
            fail("Error: No such container")
        if (ROOT / "rm-fails").exists():
            fail("Error: removal failed")
        subprocess.run(["rm", "-rf", str(CONTAINERS / item["Id"])], check=True)
        if (ROOT / "rm-races").exists():
            # Someone else removed it first.
            fail("Error: No such container")
        print(rest[-1])
    else:
        fail("unsupported fake engine command", 2)


if __name__ == "__main__":
    main()
