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
import subprocess
import sys
import time

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
    return {"kind": "directory" if path.is_dir() else "file", "size": info.st_size, "modifiedAtMs": info.st_mtime * 1000}


try:
    if operation == "describe":
        result = {"label": "Fixture environments", "description": "Independent executable fixture.", "lifecycle": []}
    elif operation == "list":
        local_id = (root / "node-id").read_text() if (root / "node-id").exists() else "target"
        nodes = [{"id": local_id, "type": "fixture", "availability": "ready", "filesystem": "read-write", "exec": True, "defaultCwd": "opaque://root"},
                 {"id": "readonly", "type": "fixture", "availability": "ready", "filesystem": "read"},
                 {"id": "offline", "type": "fixture", "availability": "offline", "filesystem": "read"}]
        if mode == "duplicate":
            nodes.append(nodes[0])
        result = {"nodes": nodes}
    elif operation == "filesystem":
        assert set(body) <= {"nodeId", "operation", "path", "context", "offset", "count", "contentBase64", "flag"}
        assert set(body["context"]) <= {"cwd"}
        assert "/" not in body["nodeId"]
        path = body["path"]
        action = body["operation"]
        if "denied" in path:
            raise PermissionError(errno.EACCES, "Target boundary denied")
        actual = physical(path)
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
                    result = {"dataBase64": base64.b64encode(source.read(body["count"])).decode()}
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
            actual.unlink()
            result = None
        else:
            raise ValueError("Unsupported filesystem operation")
    else:
        raise ValueError("Unsupported operation")
    response.update(ok=True, result=result)
except OSError as error:
    response.update(ok=False, error={"code": errno.errorcode.get(error.errno, "EIO"), "message": error.strerror or "Target filesystem error", "retryable": False})
print(json.dumps(response), flush=True)
