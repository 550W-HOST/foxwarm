# Advisor consultation: fork this Session to an advisor model, send it the question, and end
# the caller's turn in a wait on the advisor's report. One self-contained runnable entry.
#
# args: question (required), model, effort, waitSeconds. See SKILL.md frontmatter.

SUFFIX = "advice"
UNKNOWN_MODEL = "Unknown configured model key"
REQUEST = """You are an advisor. The Session that forked you, `{parent}`, asks:

{question}

Everything above is its context at the moment it asked. Investigate as far as the question needs, using only actions that change nothing: read files, search, inspect Sessions, Tasks and other state, and run commands that only read. Don't edit files, don't change Sessions, Tasks, timers or settings, don't start long-running work, and don't message anyone except `{parent}`.

When you're done, send your advice to `{parent}` with `send_to_session` and `currentSessionTurnAction: "end_turn"`. Lead with your recommendation, then give your reasons and the evidence you checked, the risks and open points to verify, and anything you would do differently. `{parent}` already has everything above, so don't restate it."""



def checked(result):
    # A failed builtin returns an object with `error` rather than raising.
    if isinstance(result, dict) and result.get("error") is not None:
        raise RuntimeError(str(result["error"]))
    return result


question = args["question"].strip()
if not question:
    raise ValueError("question must not be empty.")
explicit = args.get("model")
key = explicit.strip() if explicit is not None else "advisor"
if not key:
    raise ValueError("model must be a configured model key.")
wait_seconds = args.get("waitSeconds")
if wait_seconds is None:
    wait_seconds = 3600
if wait_seconds <= 0:
    raise ValueError("waitSeconds must be a positive number of seconds.")

status = checked(ctl("session status"))
parent = status["sessionId"]
estimate = status.get("tokenEstimate") or 0

force = {"modelId": key}
if args.get("effort") is not None:
    force["effort"] = args["effort"]

try:
    created = checked(call_tool(
        "create_child_session",
        {
            "suffix": SUFFIX,
            "fork": True,
            "displayName": "Advice: " + " ".join(question.split())[:60],
            "forceModel": force,
            "currentSessionTurnAction": "continue",
        },
    ))
except Exception as error:
    if UNKNOWN_MODEL not in str(error):
        raise
    if explicit is None:
        raise ValueError(
            "No advisor model is configured. Pass `model`, or define a model key named `advisor`."
        )
    raise ValueError("`" + key + "` is not a configured model key.")

output = created["output"]
start = output.index("`") + 1
advisor = output[start : output.index("`", start)]

limit = checked(ctl("session status @id", {"id": advisor})).get("contextLimit")
if limit and estimate > limit:
    checked(ctl("session delete @id", {"id": advisor}))
    raise ValueError(
        "This Session's context (about "
        + str(int(estimate))
        + " tokens) exceeds the context limit of `"
        + key
        + "` ("
        + str(int(limit))
        + " tokens), so the advisor can't read it. Pass a `model` with a larger context, or consult after compaction."
    )

checked(ctl("session archive @id", {"id": advisor}))
checked(call_tool(
    "send_to_session",
    {
        "sessionId": advisor,
        "message": REQUEST.replace("{parent}", parent).replace("{question}", question),
        "currentSessionTurnAction": "continue",
    },
))
checked(call_tool(
    "wait",
    {
        "waitAnySessions": [advisor],
        "wakeIfNoActivityAfterSeconds": wait_seconds,
        "reason": "Advice from " + advisor,
    },
))
return {"advisor": advisor, "model": key}
