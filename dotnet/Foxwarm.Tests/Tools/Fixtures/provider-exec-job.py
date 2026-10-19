#!/usr/bin/env python3
"""Fixture target job, independent of the adapter RPC and Core process lifetime."""
import json
import os
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
reference = sys.argv[2]
job = root / "exec" / reference
request = json.loads((job / "request.json").read_text())
cwd = root / "fs" / request["cwd"].removeprefix("opaque://")
cwd.mkdir(parents=True, exist_ok=True)
log_path = root / "fs" / "logs" / (reference + ".log")
log_path.parent.mkdir(parents=True, exist_ok=True)
script = "trap 'pwd > \"$FIXTURE_CWD\"' EXIT\n" + request["command"] + "\n"
env = dict(os.environ, FIXTURE_CWD=str(job / "cwd"))
with log_path.open("wb") as output:
    child = subprocess.Popen(["/bin/bash", "-c", script], cwd=cwd, env=env,
                             stdin=subprocess.DEVNULL, stdout=output, stderr=output)
    code = child.wait()
finished = time.time()
status = {"state": "finished", "exitCode": code,
          "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(finished)) + (".%03dZ" % (int(finished * 1000) % 1000)),
          "durationMs": (finished - request["startedAt"]) * 1000}
if (job / "cwd").exists():
    final = (job / "cwd").read_text().removesuffix("\n")
    status["cwd"] = "opaque://" + str(pathlib.Path(final).relative_to(root / "fs"))
temporary = job / "status.tmp"
temporary.write_text(json.dumps(status))
temporary.replace(job / "status.json")
