"""Target-side helper sent over SSH; no Foxwarm installation or daemon required."""
import base64
from datetime import datetime, timezone
import errno
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import uuid


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    temporary = str(path) + ".tmp"
    Path(temporary).write_text(json.dumps(value), encoding="utf-8")
    os.replace(temporary, path)


def identity(pid):
    """PID reuse and reboot must not identify an unrelated execution as running."""
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return {"start": fields[19], "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    except FileNotFoundError:
        return None


def resolve(value, cwd):
    return os.path.abspath(os.path.join(cwd, os.path.expanduser(value)))


def file_stat(value):
    mode = value.st_mode
    kind = "file" if stat.S_ISREG(mode) else "directory" if stat.S_ISDIR(mode) else "symlink" if stat.S_ISLNK(mode) else "other"
    return {"kind": kind, "size": value.st_size, "modifiedAtMs": value.st_mtime * 1000}


def filesystem(request, default_cwd):
    cwd = resolve(request.get("context", {}).get("cwd", default_cwd), os.getcwd())
    path = resolve(request["path"], cwd)
    operation = request["operation"]
    if operation == "parent":
        return {"path": os.path.dirname(path)}
    if operation == "stat":
        return file_stat(os.stat(path))
    if operation == "read":
        offset, count = request["offset"], request["count"]
        if not isinstance(offset, int) or offset < 0 or not isinstance(count, int) or count < 0 or count > 1024 * 1024:
            raise ValueError("Invalid bounded file read.")
        with open(path, "rb") as stream:
            stream.seek(offset)
            return {"dataBase64": base64.b64encode(stream.read(count)).decode("ascii")}
    if operation == "readdir":
        return [{"name": entry.name, **file_stat(entry.stat(follow_symlinks=False))} for entry in os.scandir(path)]
    if operation == "write":
        flag = request["flag"]
        if flag not in ("w", "wx", "a"):
            raise ValueError("Invalid write flag.")
        with open(path, {"wx": "xb", "w": "wb", "a": "ab"}[flag]) as stream:
            stream.write(base64.b64decode(request["contentBase64"], validate=True))
        return None
    if operation == "mkdir":
        os.makedirs(path, exist_ok=True)
        return None
    if operation == "remove":
        try:
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            else:
                os.unlink(path)
        except FileNotFoundError:
            pass
        return None
    raise ValueError("Unsupported filesystem operation.")


def run_command(directory):
    """A detached supervisor records shell completion after the SSH request exits."""
    directory = Path(directory)
    metadata = json.loads((directory / "launch.json").read_text())
    try:
        with open(directory / "output.log", "ab", buffering=0) as output:
            environment = dict(os.environ)
            environment.pop("fw_agentdir", None)
            environment.pop("fw_tmp", None)
            process = subprocess.Popen(["/bin/bash", str(directory / "command.sh")], cwd=metadata["cwd"],
                                       stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, env=environment)
            atomic_json(directory / "shell.json", {"pid": process.pid, "identity": identity(process.pid)})
            code = process.wait()
        cwd_file = directory / "cwd.txt"
        cwd = cwd_file.read_text() if cwd_file.exists() else None
        if cwd and cwd.endswith("\n"):
            cwd = cwd[:-1]
        result = {"state": "finished", "exitCode": code if code >= 0 else 128 - code, "finishedAt": timestamp()}
        if cwd:
            result["cwd"] = cwd
    except Exception:
        result = {"state": "finished", "exitCode": None, "finishedAt": timestamp(), "error": "Command supervisor failed."}
    atomic_json(directory / "status.json", result)


def start(request, cwd, state_dir):
    cwd = resolve(request.get("cwd", cwd), os.getcwd())
    if not os.path.isdir(cwd):
        raise NotADirectoryError(errno.ENOTDIR, "Command working directory does not exist.")
    if not isinstance(request.get("command"), str) or not request["command"].strip():
        raise ValueError("Command must be a non-empty string.")
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    ref = str(uuid.uuid4())
    directory = state_dir / ref
    directory.mkdir(mode=0o700)
    # The supervisor is independent of this request's Python and SSH processes.
    (directory / "runner.py").write_text(SOURCE, encoding="utf-8")
    cwd_path = shlex.quote(str(directory / "cwd.txt"))
    # Use a separately quoted trap body so target paths are shell data, never code.
    trap = "foxwarm_exit=$?; pwd > " + cwd_path + '; exit "$foxwarm_exit"'
    script = "#!/bin/bash\ntrap " + shlex.quote(trap) + " EXIT\n" + request["command"]
    if not script.endswith("\n"):
        script += "\n"
    (directory / "command.sh").write_text(script, encoding="utf-8")
    (directory / "output.log").touch(mode=0o600)
    atomic_json(directory / "launch.json", {"cwd": cwd})
    process = subprocess.Popen([sys.executable, str(directory / "runner.py"), "--run", str(directory)],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    started = timestamp()
    atomic_json(directory / "process.json", {"pid": process.pid, "identity": identity(process.pid)})
    return {"ref": "process:" + ref, "outputPath": str(directory / "output.log"), "cwd": cwd, "startedAt": started, "pid": process.pid}


def poll(request, state_dir):
    reference = request["ref"]
    if not isinstance(reference, str) or not reference.startswith("process:"):
        raise ValueError("Invalid execution reference.")
    ref = reference[len("process:"):]
    try:
        if str(uuid.UUID(ref)) != ref:
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError("Invalid execution reference.")
    directory = state_dir / ref
    try:
        if (directory / "status.json").exists():
            return json.loads((directory / "status.json").read_text())
        process = json.loads((directory / "process.json").read_text())
        if not process["identity"] or identity(process["pid"]) != process["identity"]:
            # Recheck completion after observing exit; publishing status precedes supervisor exit.
            if (directory / "status.json").exists():
                return json.loads((directory / "status.json").read_text())
            return {"state": "lost", "reason": "Execution supervisor is no longer present and no completion record is available."}
        snapshot = {"state": "running"}
        try:
            shell = json.loads((directory / "shell.json").read_text())
            if shell["identity"] and identity(shell["pid"]) == shell["identity"]:
                snapshot["cwd"] = os.readlink(f'/proc/{shell["pid"]}/cwd')
        except FileNotFoundError:
            pass
        return snapshot
    except FileNotFoundError:
        return {"state": "lost", "reason": "Execution records are no longer available."}


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--run":
        run_command(sys.argv[2])
        return
    payload = json.load(sys.stdin)
    try:
        cwd = resolve(payload["defaultCwd"], os.getcwd())
        state_dir = Path(resolve(payload["stateDir"], os.getcwd()))
        operation, request = payload["operation"], payload["request"]
        if operation == "probe":
            if not os.path.isdir(cwd):
                raise NotADirectoryError(errno.ENOTDIR, "Default working directory does not exist.")
            result = {"cwd": cwd}
        elif operation == "filesystem":
            result = filesystem(request, cwd)
        elif operation == "exec-start":
            result = start(request, cwd, state_dir)
        elif operation == "exec-poll":
            result = poll(request, state_dir)
        else:
            raise ValueError("Unsupported target operation.")
        print(json.dumps({"ok": True, "result": result}))
    except OSError as error:
        print(json.dumps({"ok": False, "error": {"code": errno.errorcode.get(error.errno, "TargetError"), "message": error.strerror or "Target filesystem operation failed."}}))
    except ValueError as error:
        print(json.dumps({"ok": False, "error": {"code": "InvalidRequest", "message": str(error)}}))


# The incoming helper records its own source for independently running supervisors.
# The launcher passes source as a literal; a saved runner reads the same file.
SOURCE = globals().get("_FOXWARM_HELPER_SOURCE")
if SOURCE is None and len(sys.argv) > 1 and sys.argv[1] == "--run":
    SOURCE = Path(__file__).read_text(encoding="utf-8")

if __name__ == "__main__":
    main()
