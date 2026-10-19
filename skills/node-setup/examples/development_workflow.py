"""ToolScript: prepare/assign/snapshot/receive work on an existing POSIX Node.

Run with Foxwarm run_script, not the Python CLI. All host effects use tools.
See ../references/development-workflow.md for prerequisites and phase inputs.
"""
import json


# Executed by Python 3 through the selected Node's ordinary exec tool, not Monty.
_NODE_SCRIPT = r'''
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

options = json.loads(sys.argv[1])

def git(*args):
    return subprocess.check_output(["git", "-C", options["workDir"], *args], text=True).strip()

if options["phase"] == "prepare":
    os.mkdir(options["workDir"])
    git("init", "--quiet")
    git("fetch", "--quiet", options["bundlePath"], "HEAD")
    base = git("rev-parse", "FETCH_HEAD")
    if base != options["base"]:
        raise ValueError("Source bundle HEAD does not equal the assigned base")
    git("checkout", "--quiet", "-b", "work", base)
    git("config", "--local", "user.name", options["gitIdentity"]["name"])
    git("config", "--local", "user.email", options["gitIdentity"]["email"])
    result = {"base": base, "workDir": options["workDir"]}
else:
    base = options["base"]
    head = git("rev-parse", "HEAD")
    git("merge-base", "--is-ancestor", base, head)
    commits = git("rev-list", "--reverse", base + ".." + head).splitlines()
    # -z preserves unusual filenames; this is evidence, not a clean-tree gate.
    dirty = subprocess.check_output(["git", "-C", options["workDir"], "status", "--porcelain=v1", "-z"], text=True)
    directory = tempfile.mkdtemp(prefix="node-delivery-", dir=options["tempDir"])
    bundle = None
    if commits:
        bundle = str(Path(directory) / "commits.bundle")
        git("bundle", "create", bundle, base + "..HEAD")
    result = {"base": base, "head": head, "commits": commits, "dirtyStatus": dirty,
              "bundlePath": bundle, "snapshotDir": directory, "workDir": options["workDir"]}
print("NODE_WORKFLOW_RESULT=" + json.dumps(result))
'''


def required(data, key):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(key + " must be a non-empty string")
    return value


def absolute(data, key):
    value = required(data, key)
    if not value.startswith("/"):
        raise ValueError(key + " must be an absolute POSIX path")
    return value


def quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def builtin(name, arguments):
    return call_tool({"source": "builtin", "name": name, "args": arguments})


def decoded(receipt):
    return json.loads(receipt["output"])


def completed(value, phase):
    if value.get("status") != "completed" or value.get("phase") != phase:
        raise ValueError("A completed " + phase + " result is required")
    return value


def parse_capture(state, capture):
    if capture.get("truncated") or not isinstance(capture.get("content"), str):
        state["status"] = "needs-content"
        return state
    rows = [line for line in capture["content"].splitlines() if line.startswith("NODE_WORKFLOW_RESULT=")]
    if not rows:
        state["status"] = "failed"
        state["error"] = "No final workflow result; inspect the exec log without replaying the command"
        return state
    state["data"] = json.loads(rows[-1].split("=", 1)[1])
    state["status"] = "completed"
    return state


def execute(state, options):
    command = "python3 -c " + quote(_NODE_SCRIPT) + " " + quote(json.dumps(options))
    receipt = call_tool({"source": "node", "nodeId": state["nodeId"], "name": "exec",
                         "args": {"command": command, "cwd": state["tempDir"], "timeout": 15}})
    state["exec"] = receipt
    if receipt.get("status") == "running":
        state["status"] = "pending"
        return state
    if receipt.get("status") != "completed" or receipt.get("exitCode") != 0:
        state["status"] = "failed"
        return state
    return parse_capture(state, receipt)


def transfer(state, source_node, source_path, target_node, target_path):
    state["stage"] = "copy " + source_path
    receipt = builtin("copy_between_nodes", {"sourceNode": source_node, "sourcePath": source_path,
                      "targetNode": target_node, "targetPath": target_path})
    state["transfers"].append({"sourceNode": source_node, "sourcePath": source_path,
                               "targetNode": target_node, "targetPath": target_path, "receipt": receipt})


def main(args):
    phase = required(args, "phase")
    state = {"phase": phase, "status": "failed", "transfers": [], "stage": "inputs"}
    try:
        if phase == "prepare":
            node = required(args, "nodeId")
            if node == "master":
                raise ValueError("nodeId must select an existing non-master Node")
            base = required(args, "base")
            if len(base) not in (40, 64) or any(character not in "0123456789abcdef" for character in base):
                raise ValueError("base must be a full lowercase Git commit ID")
            work = absolute(args, "workDir")
            temporary = absolute(args, "tempDir")
            bundle = absolute(args, "bundlePath")
            identity = args["gitIdentity"]
            required(identity, "name")
            required(identity, "email")
            source_node = required(args, "sourceNode")
            source_bundle = absolute(args, "sourceBundle")
            materials = args.get("materials", [])
            for material in materials:
                absolute(material, "sourcePath")
                absolute(material, "targetPath")
            state.update({"nodeId": node, "base": base, "workDir": work, "tempDir": temporary,
                          "materials": materials})
            transfer(state, source_node, source_bundle, node, bundle)
            for material in materials:
                transfer(state, source_node, material["sourcePath"], node, material["targetPath"])
            state["stage"] = "initialize workspace"
            return execute(state, {"phase": phase, "workDir": work, "base": base,
                                   "bundlePath": bundle, "gitIdentity": identity})

        if phase == "assign":
            prepared = completed(args["prepared"], "prepare")
            state["prepared"] = prepared
            child = dict(args["child"])
            required(child, "suffix")
            if args.get("taskId"):
                task_id = required(args, "taskId")
                state["taskId"] = task_id
                task = decoded(builtin("task", {"action": "get", "taskId": task_id}))["task"]
            else:
                task = args["task"]
                title = required(task, "title")
                brief = required(task, "description")
                brief += "\n\nAssigned Node: " + prepared["nodeId"] + "\nWorkspace: " + prepared["workDir"]
                brief += "\nCommitted base: " + prepared["base"]
                brief += "\nMaterials: " + json.dumps([item["targetPath"] for item in prepared["materials"]])
                brief += "\nComplete this Task with actual changes, validation, dirty state and evidence paths; completion is the report."
                state["stage"] = "create task"
                receipt = builtin("task", {"action": "create", "title": title, "description": brief})
                state["taskReceipt"] = receipt
                task_id = decoded(receipt)["taskId"]
                state["taskId"] = task_id
            # Keep real caller-written review fields intact and confirmation last.
            confirmation = child.pop("handoffConfirmation", None)
            child["taskId"] = task_id
            child["node"] = prepared["nodeId"]
            child["displayName"] = child.get("displayName") or task["title"]
            if confirmation is not None:
                child["handoffConfirmation"] = confirmation
            state["stage"] = "create child"
            state["childReceipt"] = builtin("create_child_session", child)
            state["taskState"] = decoded(builtin("task", {"action": "get", "taskId": task_id}))["task"]
            delivered = state["childReceipt"].get("sentNotifications", 0) > 0
            confirmed = state["taskState"].get("assignmentNotificationStatus") == "sent"
            state["status"] = "completed" if delivered and confirmed else "needs-verification"
            return state

        if phase == "snapshot":
            state.update({"nodeId": required(args, "nodeId"), "tempDir": absolute(args, "tempDir")})
            state["stage"] = "snapshot committed work"
            return execute(state, {"phase": phase, "workDir": absolute(args, "workDir"),
                                   "base": required(args, "base"), "tempDir": state["tempDir"]})

        if phase == "collect":
            state = dict(args["pending"])
            receipt = state["exec"]
            if state.get("status") not in ("pending", "needs-content"):
                raise ValueError("collect requires a pending or needs-content exec result")
            if args.get("exitCode") != 0:
                state["status"] = "failed"
                return state
            state["stage"] = "read completed exec log"
            # Use the actual same-Node log locator from the exec/completion event.
            capture = call_tool({"source": "node", "nodeId": state["nodeId"], "name": "read",
                                 "args": {"filePath": args.get("logPath") or receipt["logPath"]}})
            return parse_capture(state, capture)

        if phase == "receive":
            snapshot = completed(args["snapshot"], "snapshot")
            state["snapshot"] = snapshot
            destination = absolute(args, "artifactDir").rstrip("/")
            target = required(args, "targetNode")
            evidence = args.get("evidence", [])
            for item in evidence:
                absolute(item, "path")
                name = required(item, "name")
                if name in (".", "..", "commits.bundle") or "/" in name or "\\" in name:
                    raise ValueError("Evidence name must be a filename other than commits.bundle")
            bundle = snapshot["data"]["bundlePath"]
            if bundle is not None:
                transfer(state, snapshot["nodeId"], bundle, target, destination + "/commits.bundle")
            for item in evidence:
                transfer(state, snapshot["nodeId"], item["path"], target, destination + "/" + item["name"])
            state["status"] = "completed"
            return state

        raise ValueError("Unknown phase: " + phase)
    except Exception as error:
        state["status"] = "failed"
        state["error"] = str(error)
        return state
