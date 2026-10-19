#!/usr/bin/env python3
"""Independent one-request executable Node provider. Requires OpenSSH and Python 3."""
import argparse
import json
from pathlib import Path
import shlex
import signal
import subprocess
import sys

PROTOCOL = "foxwarm-node-provider"
DESCRIPTION = {
    "label": "Linux SSH",
    "description": "Existing Linux machines accessed with OpenSSH and Python 3. Commands use the SSH account's permissions; this provider is not a sandbox.",
    "lifecycle": [],
    "dataRetention": "Command logs and execution records remain in each target's configured state directory until the administrator removes them. No automatic machine or data deletion is provided.",
}


def remote(node, operation, request=None):
    # Standard SSH identities, configured agents and known_hosts remain authoritative.
    # Strict host verification is required even if an extra option tries to disable it.
    helper = Path(__file__).with_name("target.py").read_text(encoding="utf-8")
    command = ["ssh", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10"]
    command += node.get("sshArgs", [])
    command += ["--", node["target"], "python3 -c " + shlex.quote("_FOXWARM_HELPER_SOURCE = " + repr(helper) + "\nexec(compile(_FOXWARM_HELPER_SOURCE, '<ssh-provider>', 'exec'))")]
    payload = {"operation": operation, "request": request or {},
               "defaultCwd": node.get("cwd", "~"), "stateDir": node.get("stateDir", "~/.local/state/foxwarm-ssh-provider")}
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        output, _ = child.communicate(json.dumps(payload).encode())
    finally:
        # Bound only this request transport, not its already detached target command.
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=0.15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
    if child.returncode:
        raise RuntimeError("SSH request failed. Check connection, authentication, host verification and target Python 3 availability.")
    return json.loads(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Private JSON connection configuration")
    args = parser.parse_args()
    nodes = json.loads(Path(args.config).read_text(encoding="utf-8"))["nodes"]
    if not isinstance(nodes, list) or len({node["id"] for node in nodes}) != len(nodes):
        raise ValueError("Configuration must contain unique Node IDs.")
    for node in nodes:
        if not isinstance(node.get("target"), str) or not node["target"] or node["target"].startswith("-"):
            raise ValueError("Each Node requires an SSH destination.")
        if not isinstance(node.get("sshArgs", []), list) or not all(isinstance(arg, str) for arg in node.get("sshArgs", [])):
            raise ValueError("sshArgs must be an array of strings.")
    envelope = json.load(sys.stdin)
    reply = {key: envelope.get(key) for key in ("protocol", "providerId", "requestId", "operation")}
    try:
        if envelope.get("protocol") != PROTOCOL:
            raise ValueError("Unsupported provider protocol.")
        operation = envelope["operation"]
        request = envelope.get("request", {})
        if operation == "describe":
            result = DESCRIPTION
        elif operation == "list":
            result = {"nodes": []}
            for node in nodes:
                try:
                    probe = remote(node, "probe")
                except Exception:
                    probe = {"ok": False}
                ready = probe.get("ok") is True
                result["nodes"].append({"id": node["id"], "label": node.get("label", node["id"]),
                                        "kind": "remote", "type": "linux-ssh", "availability": "ready" if ready else "offline",
                                        "filesystem": "read-write", "exec": True,
                                        "defaultCwd": probe.get("result", {}).get("cwd", node.get("cwd", "~"))})
        elif operation in ("filesystem", "exec-start", "exec-poll"):
            node = next((node for node in nodes if node["id"] == request.get("nodeId")), None)
            if node is None:
                raise ValueError("Unknown Node ID.")
            response = remote(node, operation, request)
            if not response["ok"]:
                reply.update(ok=False, error=response["error"])
                print(json.dumps(reply))
                return
            result = response["result"]
        else:
            reply.update(ok=False, error={"code": "UnsupportedOperation", "message": "This provider only accesses existing machines; lifecycle operations are not supported."})
            print(json.dumps(reply))
            return
        reply.update(ok=True, result=result)
    except Exception as error:
        # Never return the SSH command, connection configuration or stderr.
        message = str(error) if isinstance(error, (ValueError, RuntimeError)) else "Provider request failed."
        reply.update(ok=False, error={"code": "SSHProviderError", "message": message, "retryable": False})
    print(json.dumps(reply))


def stop_request(_signal, _frame):
    raise SystemExit(1)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop_request)
    main()
