#!/usr/bin/env python3
"""Independent Provider fixture with the optional persistent service channel.

Usage: node-provider-services.py ROOT [MODE]

One-shot operations (describe, list) answer one request and exit. `connect` keeps stdin/stdout
open and serves the node_service_* frames as NDJSON until stdin reaches EOF. Every process start
and every service frame is appended to ROOT/channel.jsonl so tests can assert launch counts.
"""
import base64
import fcntl
import json
import os
import pathlib
import pty
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import uuid

root = pathlib.Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "normal"
root.mkdir(parents=True, exist_ok=True)
(root / "work").mkdir(exist_ok=True)
log_lock = threading.Lock()
out_lock = threading.Lock()

SERVICES = {"vscode-fs": 1, "vscode-git": 1, "vscode-pty": 1}


def log(entry):
    with log_lock, (root / "channel.jsonl").open("a") as handle:
        handle.write(json.dumps(entry) + "\n")


def emit(value):
    data = (json.dumps(value) + "\n").encode()
    with out_lock:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def descriptors():
    work = str(root / "work")
    base = {"type": "fixture", "availability": "ready", "filesystem": "read-write", "defaultCwd": work}
    nodes = [
        dict(base, id="svc", label="Service node", services=dict(SERVICES)),
        dict(base, id="svc2", label="Second service node", services=dict(SERVICES)),
        dict(base, id="plain", label="No services"),
        dict(base, id="fsonly", label="Filesystem only", services={"vscode-fs": 1}),
        dict(base, id="down", label="Offline", availability="offline", services=dict(SERVICES)),
    ]
    if (root / "offline").exists():
        nodes[0]["availability"] = "offline"
    if mode == "list-no-services":
        for node in nodes:
            node.pop("services", None)
    if mode == "list-bad-services":
        nodes[0]["services"] = {"vscode-fs": 0}
    if mode == "list-unknown-service":
        nodes[0]["services"] = dict(SERVICES, **{"future-service": 3})
    return nodes


class ServiceError(Exception):
    def __init__(self, code, message, status=500):
        super().__init__(message)
        self.code = code
        self.status = status


def one_shot(request):
    operation = request["operation"]
    log({"oneShot": operation})
    response = {key: request[key] for key in ("protocol", "providerId", "requestId", "operation")}
    if operation == "describe":
        response.update(ok=True, result={
            "label": "Service fixture",
            "description": "Fixture with persistent Code services.",
            "lifecycle": [],
        })
    elif operation == "list":
        response.update(ok=True, result={"nodes": descriptors()})
    else:
        response.update(ok=False, error={"code": "UNSUPPORTED", "message": "Unsupported fixture operation."})
    sys.stdout.write(json.dumps(response) + "\n")


def file_type(path):
    flags = 2 if os.path.isdir(path) else 1
    return flags | (64 if os.path.islink(path) else 0)


def stat(path):
    try:
        info = os.stat(path)
    except FileNotFoundError:
        raise ServiceError("FileNotFound", "File not found: " + path, 404)
    return {
        "type": file_type(path),
        "ctime": info.st_ctime * 1000,
        "mtime": info.st_mtime * 1000,
        "size": 0 if os.path.isdir(path) else info.st_size,
    }


def absolute(args, key):
    value = args.get(key)
    if not isinstance(value, str) or not value.startswith("/"):
        raise ServiceError("InvalidPath", key + " must be an absolute path.", 400)
    return os.path.normpath(value)


def fs(operation, args):
    path = absolute(args, "path")
    if operation == "stat":
        return stat(path)
    if operation == "read-directory":
        try:
            names = sorted(os.listdir(path))
        except FileNotFoundError:
            raise ServiceError("FileNotFound", "File not found: " + path, 404)
        return {"entries": [{"name": name, "type": file_type(os.path.join(path, name))} for name in names]}
    if operation == "read-file":
        try:
            with open(path, "rb") as handle:
                return {"contentBase64": base64.b64encode(handle.read()).decode()}
        except FileNotFoundError:
            raise ServiceError("FileNotFound", "File not found: " + path, 404)
    if operation == "write-file":
        data = base64.b64decode(args.get("contentBase64", ""))
        exists = os.path.exists(path)
        if exists and not args.get("overwrite"):
            raise ServiceError("FileExists", "File exists: " + path, 409)
        if not exists and not args.get("create"):
            raise ServiceError("FileNotFound", "File not found: " + path, 404)
        with open(path, "wb") as handle:
            handle.write(data)
        return {"success": True, "stat": stat(path)}
    if operation == "create-directory":
        os.makedirs(path, exist_ok=True)
        return {"success": True, "stat": stat(path)}
    if operation == "delete":
        if os.path.isdir(path):
            if not args.get("recursive"):
                raise ServiceError("DirectoryNotEmpty", "Directory is not empty.", 409)
            import shutil
            shutil.rmtree(path)
        else:
            os.remove(path)
        return {"success": True}
    if operation == "rename":
        target = absolute(args, "newPath")
        if os.path.exists(target) and not args.get("overwrite"):
            raise ServiceError("FileExists", "File exists: " + target, 409)
        os.replace(path, target)
        return {"success": True, "stat": stat(target)}
    raise ServiceError("UnsupportedOperation", "Unsupported vscode-fs operation: " + operation, 400)


def git(args, *command):
    workspace = absolute(args, "workspace")
    return workspace, subprocess.run(
        ["git", "-C", workspace, *command], capture_output=True, check=False
    )


def vscode_git(operation, args):
    if operation == "status":
        workspace, top = git(args, "rev-parse", "--show-toplevel")
        if top.returncode != 0:
            raise ServiceError("GitError", "Not a Git workspace.", 422)
        top_level = top.stdout.decode().strip()
        _, porcelain = git(args, "status", "--porcelain=v1", "-z", "-uall")
        changes = []
        for row in porcelain.stdout.decode().split("\0"):
            if len(row) < 4:
                continue
            xy, path = row[:2], row[3:]
            kind = "untracked" if xy == "??" else "modified" if "M" in xy else "added" if "A" in xy else "deleted" if "D" in xy else "changed"
            changes.append({"path": path, "indexStatus": xy[0], "workingTreeStatus": xy[1], "kind": kind})
        return {"workspace": top_level, "topLevel": top_level, "changes": changes}
    if operation == "content":
        workspace, shown = git(args, "show", "HEAD:" + str(args.get("path")))
        return {"contentBase64": base64.b64encode(shown.stdout if shown.returncode == 0 else b"").decode()}
    raise ServiceError("UnsupportedOperation", "Unsupported vscode-git operation: " + operation, 400)


class Terminal:
    def __init__(self, cwd, cols, rows):
        self.id = os.environ.get("FIXTURE_TERMINAL_ID_PREFIX", "t") + uuid.uuid4().hex[:6]
        if mode == "fixed-terminal-ids":
            self.id = "1"
        self.cwd = cwd
        self.cols, self.rows = cols, rows
        self.created = int(time.time() * 1000)
        self.backlog = ""
        self.attached = False
        self.closed = False
        self.done = threading.Event()
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.environ["TERM"] = "xterm-256color"
            os.execv("/bin/sh", ["/bin/sh", "-i"])
        self.pid, self.fd = pid, fd
        self.resize(cols, rows)
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=self.wait, daemon=True).start()

    def describe(self):
        return {"id": self.id, "shell": "/bin/sh", "cwd": self.cwd, "cols": self.cols,
                "rows": self.rows, "createdAt": self.created, "pid": self.pid}

    def resize(self, cols, rows):
        self.cols, self.rows = cols, rows
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def read(self):
        decoder = __import__("codecs").getincrementaldecoder("utf-8")("replace")
        while True:
            try:
                data = os.read(self.fd, 4096)
            except OSError:
                break
            if not data:
                break
            text = decoder.decode(data)
            with state_lock:
                self.backlog = (self.backlog + text)[-200000:]
                if self.attached and not self.closed:
                    emit({"type": "node_service_event", "service": "vscode-pty",
                          "event": {"type": "output", "terminalId": self.id, "data": text}})

    def wait(self):
        _, status = os.waitpid(self.pid, 0)
        time.sleep(0.2)  # let the reader publish final output before the exit event
        with state_lock:
            terminals.pop(self.id, None)
            if not self.closed:
                event = {"type": "exit", "terminalId": self.id,
                         "exitCode": os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 0,
                         "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0}
                emit({"type": "node_service_event", "service": "vscode-pty", "event": event})
            self.closed = True
        try:
            os.close(self.fd)
        except OSError:
            pass
        self.done.set()

    def close(self):
        with state_lock:
            self.closed = True
        for sig in (signal.SIGHUP, signal.SIGKILL):
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                break
            if self.done.wait(1):
                break
        self.done.wait(2)


terminals = {}
state_lock = threading.RLock()


def terminal(args):
    found = terminals.get(str(args.get("terminalId", "")).strip())
    if found is None:
        raise ServiceError("Unknown", "Terminal not found: " + str(args.get("terminalId")), 404)
    return found


def vscode_pty(operation, args):
    if operation == "create":
        cwd = args.get("cwd")
        if not isinstance(cwd, str) or not os.path.isdir(cwd):
            raise ServiceError("Unknown", "Directory does not exist: " + str(cwd), 400)
        record = Terminal(cwd, max(20, int(args.get("cols", 100))), max(5, int(args.get("rows", 30))))
        with state_lock:
            terminals[record.id] = record
        return {"terminal": record.describe()}
    if operation == "list":
        with state_lock:
            return {"terminals": [t.describe() for t in sorted(terminals.values(), key=lambda t: -t.created)]}
    if operation == "get":
        with state_lock:
            found = terminals.get(str(args.get("terminalId", "")))
            return {"terminal": found.describe() if found else None}
    if operation == "attach":
        with state_lock:
            record = terminal(args)
            record.attached = True
            return {"terminal": record.describe(), "backlog": record.backlog}
    if operation == "detach":
        with state_lock:
            terminal(args).attached = False
        return {"success": True}
    if operation == "input":
        os.write(terminal(args).fd, str(args.get("data", "")).encode())
        return {"success": True}
    if operation == "resize":
        terminal(args).resize(max(20, int(args["cols"])), max(5, int(args["rows"])))
        return {"success": True}
    if operation == "close":
        found = terminals.get(str(args.get("terminalId", "")))
        if found:
            found.close()
        return {"success": True}
    if operation == "code-result":
        return {"success": True}
    raise ServiceError("UnsupportedOperation", "Unsupported vscode-pty operation: " + operation, 400)


def serve(service, operation, args):
    if service == "vscode-fs":
        return fs(operation, args)
    if service == "vscode-git":
        return vscode_git(operation, args)
    if service == "vscode-pty":
        return vscode_pty(operation, args)
    raise ServiceError("Unknown", "Unsupported node service: " + service, 400)


def connect(request):
    node_id = request["request"]["nodeId"]
    log({"connect": node_id, "pid": os.getpid()})
    if mode == "stderr-flood":
        sys.stderr.write("x" * 300000)
        sys.stderr.flush()
    if mode == "connect-hang":
        time.sleep(30)
    if mode == "connect-exit":
        sys.exit(3)
    if mode == "connect-error":
        emit({**{k: request[k] for k in ("protocol", "providerId", "requestId", "operation")},
              "ok": False, "error": {"code": "NO_SERVICES", "message": "Target environment is not reachable.", "retryable": True}})
        return
    response = {key: request[key] for key in ("protocol", "providerId", "requestId", "operation")}
    if mode == "connect-identity":
        response["requestId"] = "different"
    confirmed = "other-node" if mode == "connect-wrong-node" else node_id
    services = dict(SERVICES)
    if node_id == "fsonly":
        services = {"vscode-fs": 1}
    response.update(ok=True, result={"nodeId": confirmed, "services": services})
    emit(response)
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            log({"eof": node_id})
            return
        frame = json.loads(line)
        log({"frame": frame["type"], "service": frame.get("service"), "operation": frame.get("operation"), "node": node_id})
        if frame.get("operation") == "crash":
            os._exit(9)
        if frame.get("operation") == "garbage":
            sys.stdout.buffer.write(b"not json\n")
            sys.stdout.buffer.flush()
            continue
        if frame.get("operation") == "oversize":
            sys.stdout.buffer.write(b"a" * (73 * 1024 * 1024) + b"\n")
            sys.stdout.buffer.flush()
            continue
        if frame.get("operation") == "slow":
            time.sleep(0.2)
        if frame["type"] == "node_service_command":
            try:
                serve(frame["service"], frame["operation"], frame.get("args", {}))
            except Exception as error:
                emit({"type": "node_service_event", "service": frame["service"], "event": {
                    "type": "error", "operation": frame["operation"],
                    "terminalId": frame.get("args", {}).get("terminalId"),
                    "error": {"code": "Unknown", "message": str(error), "statusCode": 500}}})
            continue
        try:
            result = serve(frame["service"], frame["operation"], frame.get("args", {}))
            emit({"type": "node_service_response", "requestId": frame["requestId"], "result": result})
        except ServiceError as error:
            emit({"type": "node_service_error", "requestId": frame["requestId"],
                  "error": {"code": error.code, "message": str(error), "statusCode": error.status}})


first = json.loads(sys.stdin.buffer.readline())
if first["operation"] == "connect":
    connect(first)
else:
    one_shot(first)
