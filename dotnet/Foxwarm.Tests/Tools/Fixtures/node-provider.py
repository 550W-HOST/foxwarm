#!/usr/bin/env python3
"""Independent one-shot provider used only with an explicitly owned fixture directory."""
import base64
import errno
import json
import ntpath
import os
import pathlib
import posixpath
import signal
import stat as file_stat
import subprocess
import sys
import time
import uuid

root = pathlib.Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "normal"
request = json.load(sys.stdin)
operation = request["operation"]
body = request.get("request", {})
root.mkdir(parents=True, exist_ok=True)
with (root / "calls.jsonl").open("a") as log:
    event = {"operation": operation, "request": {k: v for k, v in body.items() if k != "contentBase64"}}
    if "contentBase64" in body:
        event["writeBytes"] = len(base64.b64decode(body["contentBase64"]))
    event["environmentLeak"] = "FOXWARM_PROVIDER_SECRET" in os.environ
    log.write(json.dumps(event) + "\n")
if mode == "hang":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(20)
if mode == "slow":
    time.sleep(0.4)
if mode == "exit":
    sys.stderr.write("private launcher diagnostic")
    sys.exit(7)
if mode == "stdout":
    sys.stdout.write("x" * (9 * 1024 * 1024))
    sys.exit(0)
if mode == "stderr":
    sys.stderr.write("x" * 70000)
    sys.stderr.flush()
    time.sleep(20)
if mode == "multiple":
    print("{}\n{}")
    sys.exit(0)
if mode == "inherited":
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(3)"], stdin=subprocess.DEVNULL)

response = {k: request[k] for k in ("protocol", "providerId", "requestId", "operation")}
if mode == "identity":
    response["requestId"] = "different"


def target(path):
    cwd = body.get("context", {}).get("cwd", "opaque://root")
    if path.startswith("opaque://"):
        return posixpath.normpath(path[len("opaque://"):])
    if len(path) > 1 and path[1] == ":":
        return "windows/" + path.replace("\\", "/").replace(":", "")
    if path.startswith("/"):
        return posixpath.normpath(path.lstrip("/"))
    return posixpath.normpath(cwd.removeprefix("opaque://") + "/" + path)


def physical(path):
    key = target(path)
    if key == ".." or key.startswith("../"):
        raise PermissionError(errno.EACCES, "Target boundary denied")
    return root / "fs" / key


def stat(path):
    info = path.stat()
    kind = "directory" if file_stat.S_ISDIR(info.st_mode) else "file" if file_stat.S_ISREG(info.st_mode) else "other"
    return {"kind": kind, "size": info.st_size, "modifiedAtMs": info.st_mtime * 1000}


try:
    if operation == "describe":
        result = {"label": "Fixture environments", "description": "Independent executable fixture.", "lifecycle": []}
        if mode == "lifecycle":
            result.update(lifecycle=["create", "ensure", "inspect", "destroy"],
                          createParameters={"type": "object", "properties": {"label": {"type": "string"}}},
                          ensureParameters={"type": "object"}, lifecycleDescription="Manage disposable fixture environments.",
                          dataRetention="Destroy removes discovery; target files remain.")
        if (root / "description.json").exists():
            result = json.loads((root / "description.json").read_text())
    elif operation == "list":
        if (root / "list-unavailable").exists():
            raise OSError(errno.EIO, "Directory temporarily unavailable")
        local_id = (root / "node-id").read_text() if (root / "node-id").exists() else "target"
        nodes = [{"id": local_id, "type": "fixture", "availability": "ready", "filesystem": "read-write", "exec": True, "defaultCwd": "opaque://root"},
                 {"id": "readonly", "type": "fixture", "availability": "ready", "filesystem": "read"},
                 {"id": "offline", "type": "fixture", "availability": "offline", "filesystem": "read"}]
        if mode == "duplicate":
            nodes.append(nodes[0])
        if mode == "lifecycle":
            environments = [json.loads(p.read_text()) for p in sorted((root / "environments").glob("*.json"))]
            ensured = {node["id"] for node in environments}
            nodes = [node for node in nodes if node["id"] not in ensured] + environments
        if (root / "forged-parent").exists():
            nodes[0]["parentNode"] = "untrusted-parent"
        result = {"nodes": nodes}
    elif operation in ("create", "ensure", "inspect", "destroy"):
        assert mode == "lifecycle"
        assert set(body) <= {"sourceSessionId", "nodeId", "parameters", "context"}
        assert set(body["context"]) == {"agent"}
        assert body["sourceSessionId"]
        local = body.get("nodeId", "generated")
        assert "/" not in local
        environments = root / "environments"
        environments.mkdir(exist_ok=True)
        descriptor_path = environments / (local + ".json")
        parameters = body["parameters"]
        if operation in ("create", "ensure"):
            descriptor = {"id": local, "label": parameters.get("label", local), "type": "fixture", "kind": "sandbox",
                          "availability": "ready", "filesystem": "read-write", "exec": True, "defaultCwd": "opaque://root"}
            descriptor_path.write_text(json.dumps(descriptor))
            with (root / "effects.jsonl").open("a") as effects:
                effects.write(json.dumps({"operation": operation, "nodeId": local}) + "\n")
            if parameters.get("block"):
                (root / "effect-started").touch()
                deadline = time.monotonic() + 10
                while not (root / "release-effect").exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
            if parameters.get("lostReceipt"):
                print("{}\n{}", flush=True)
                sys.exit(0)
            if parameters.get("wrongIdentity"):
                descriptor["id"] = "wrong-result"
            result = {"node": descriptor, "effect": operation + " completed", "dataRetention": "Target files retained.",
                      "details": {"parameters": parameters, "sourceSessionId": body["sourceSessionId"], "context": body["context"], "nodeId": "business-data-not-qualified"}}
        elif operation == "inspect":
            descriptor = json.loads(descriptor_path.read_text()) if descriptor_path.exists() else {"id": local, "type": "fixture", "availability": "ready", "filesystem": "read-write"}
            result = {"node": descriptor, "details": {"parameters": parameters}}
        else:
            descriptor_path.unlink(missing_ok=True)
            with (root / "effects.jsonl").open("a") as effects:
                effects.write(json.dumps({"operation": operation, "nodeId": local}) + "\n")
            result = {"nodeId": "wrong-result" if parameters.get("wrongIdentity") else local, "effect": "Removed from discovery.", "dataRetention": "Target files retained."}
        if (root / "details.json").exists():
            result["details"] = json.loads((root / "details.json").read_text())
    elif operation == "exec-start":
        assert set(body) <= {"nodeId", "command", "cwd"}
        assert "/" not in body["nodeId"]
        reference = uuid.uuid4().hex
        job = root / "exec" / reference
        job.mkdir(parents=True)
        cwd = body.get("cwd", "opaque://root")
        started = time.time()
        metadata = {"command": body["command"], "cwd": cwd, "startedAt": started}
        (job / "request.json").write_text(json.dumps(metadata))
        child = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).with_name("provider-exec-job.py")), str(root), reference],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        (job / "pid").write_text(str(child.pid))
        if mode == "lost-start":
            print("{}\n{}", flush=True)
            sys.exit(0)
        if mode == "slow-start":
            time.sleep(2)
        if mode == "hang-start":
            time.sleep(20)
        result = {"ref": reference, "outputPath": "opaque://logs/" + reference + ".log", "cwd": cwd,
                  "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(started)) + (".%03dZ" % (int(started * 1000) % 1000)), "pid": child.pid}
    elif operation == "exec-poll":
        assert set(body) == {"nodeId", "ref"}
        assert "/" not in body["nodeId"]
        reference = body["ref"]
        job = root / "exec" / reference
        delays = json.loads((root / "poll-delay").read_text()) if (root / "poll-delay").exists() else {}
        time.sleep(delays.get(reference, delays.get("*", 0)))
        if (root / "poll-error").exists():
            raise OSError(errno.EIO, "Temporary query failure")
        if (root / "poll-lost").exists() or not job.exists():
            result = {"state": "lost", "reason": "Fixture execution records lost"}
        elif (job / "status.json").exists():
            result = json.loads((job / "status.json").read_text())
        else:
            result = {"state": "running"}
    elif operation == "filesystem":
        assert set(body) <= {"nodeId", "operation", "path", "context", "offset", "count", "contentBase64", "flag"}
        assert set(body["context"]) <= {"cwd"}
        assert "/" not in body["nodeId"]
        path = body["path"]
        action = body["operation"]
        if "denied" in path:
            raise PermissionError(errno.EACCES, "Target boundary denied")
        actual = physical(path)
        if path.startswith("opaque://logs/") and (root / "missing-output").exists():
            raise FileNotFoundError(errno.ENOENT, "Fixture log unavailable")
        if path.startswith("opaque://logs/") and (root / "slow-output").exists():
            time.sleep(20)
        if action == "parent":
            if len(path) > 1 and path[1] == ":":
                parent = ntpath.dirname(path)
            else:
                parent = "opaque://" + posixpath.dirname(target(path))
            result = {"path": parent}
        elif action == "stat":
            result = stat(actual)
        elif action == "readdir":
            result = [dict(stat(child), name=child.name) for child in actual.iterdir()]
        elif action == "read":
            if mode == "invalid-base64":
                result = {"dataBase64": "Y Q=="}
            elif mode == "short-read":
                result = {"dataBase64": ""}
            else:
                with actual.open("rb") as source:
                    source.seek(body["offset"])
                    data = source.read(body["count"])
                if mode == "premature-short" and body["offset"] == 0:
                    data = data[:-1]
                if mode == "snapshot-append" and body["offset"] + len(data) == actual.stat().st_size and not (root / "appended").exists():
                    with actual.open("ab") as output:
                        output.write(b"# appended after snapshot\n")
                    (root / "appended").touch()
                result = {"dataBase64": base64.b64encode(data).decode()}
        elif action == "mkdir":
            actual.mkdir(parents=True, exist_ok=True)
            result = None
        elif action == "write":
            if body["flag"] == "a" and (root / "fail-append").exists():
                raise PermissionError(errno.EACCES, "Append rejected")
            with actual.open({"w": "wb", "wx": "xb", "a": "ab"}[body["flag"]]) as output:
                output.write(base64.b64decode(body["contentBase64"], validate=True))
            if mode == "lost-write":
                print("{}\n{}", flush=True)
                sys.exit(0)
            result = None
        elif action == "remove":
            try:
                actual.unlink()
            except FileNotFoundError:
                pass
            result = None
        else:
            raise ValueError("Unsupported filesystem operation")
    else:
        raise ValueError("Unsupported operation")
    response.update(ok=True, result=result)
except OSError as error:
    response.update(ok=False, error={"code": errno.errorcode.get(error.errno, "EIO"), "message": error.strerror or "Target filesystem error", "retryable": False})
print(json.dumps(response), flush=True)
