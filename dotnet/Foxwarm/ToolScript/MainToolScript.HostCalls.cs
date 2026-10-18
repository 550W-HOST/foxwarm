using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Foxwarm.ToolScript;

internal sealed partial class MainToolScript
{
    private async Task<JsonNode?> HostCallAsync(
        string name,
        JsonArray positional,
        JsonObject kwargs,
        ActiveRun run,
        ToolScriptDataBudget budget
    )
    {
        run.Token.ThrowIfCancellationRequested();
        var record = run.Record;
        var context = run.Context;
        record["hostCallCount"] = (int)Number(record["hostCallCount"], 0) + 1;
        var last = new JsonObject
        {
            ["functionName"] = name,
            ["startedAt"] = Now(),
            ["status"] = "running",
        };
        record["lastHostCall"] = last;
        var watch = Stopwatch.StartNew();
        JsonObject? subcall = null;
        try
        {
            switch (name)
            {
                case "call_tool":
                    var wrapper = Wrapper(positional, kwargs);
                    var toolName = Text(wrapper["name"]) ?? Text(wrapper["toolId"]) ?? "call_tool";
                    last["summaryName"] = toolName;
                    var arguments = wrapper["args"] as JsonObject ?? new JsonObject();
                    var summary =
                        Text(arguments["filePath"])
                        ?? Text(arguments["command"])
                        ?? string.Join(", ", arguments.Select(pair => pair.Key).Take(2));
                    if (summary.Length > 80)
                        summary = summary[..80] + "…";
                    subcall = new JsonObject
                    {
                        ["id"] = "tsc_" + Guid.NewGuid().ToString("N"),
                        ["name"] = toolName,
                        ["argsSummary"] = summary,
                        ["startedAt"] = Now(),
                        ["status"] = "running",
                        ["isMcp"] =
                            Text(wrapper["source"]) == "mcp"
                            || (
                                Text(wrapper["toolId"])
                                    ?.StartsWith("mcp:", StringComparison.Ordinal)
                                ?? false
                            ),
                    };
                    (
                        record["subCalls"] as JsonArray
                        ?? throw new InvalidDataException("Missing ToolScript subcall state.")
                    ).Add(subcall);
                    Emit();
                    var previousDeliveryCapture = context.SessionMessageDelivered;
                    JsonNode? result;
                    try
                    {
                        context.SessionMessageDelivered = delivery =>
                        {
                            var evidence = (JsonObject)delivery.DeepClone();
                            evidence["id"] = subcall["id"]!.DeepClone();
                            subcall["sessionMessage"] = evidence;
                        };
                        result = await context.CallTool(wrapper, budget, run.Token);
                    }
                    finally
                    {
                        context.SessionMessageDelivered = previousDeliveryCapture;
                    }
                    budget.JsonValue(result);
                    (
                        record["executedTools"] as JsonArray
                        ?? throw new InvalidDataException("Missing ToolScript tool history.")
                    ).Add(toolName);
                    return result;
                case "request_model_without_context":
                    var prompt =
                        positional.Count > 0 ? Text(positional[0]) : Text(kwargs["prompt"]);
                    if (prompt is null)
                        throw new InvalidDataException(
                            "request_model_without_context requires a string prompt."
                        );
                    var modelValue = positional.Count > 1 ? positional[1] : kwargs["model"];
                    var model = Text(modelValue);
                    if (modelValue is not null && model is null)
                        throw new InvalidDataException(
                            "request_model_without_context model must be a string."
                        );
                    var answer = await context.RequestModel(prompt, model, budget, run.Token);
                    budget.JsonValue(answer);
                    return answer;
                case "session_create":
                case "session_step":
                case "session_recv":
                case "session_resume_agent":
                    throw new NotSupportedException(
                        "Managed ToolScript host functions are not available on this Main host."
                    );
                default:
                    throw new InvalidDataException(
                        "Unknown ToolScript host function: "
                            + name
                            + ". Available functions are call_tool, ask_agent and request_model_without_context."
                    );
            }
        }
        catch (Exception error)
        {
            last["status"] = "failed";
            last["error"] = error.Message;
            if (subcall is not null)
            {
                subcall["status"] = "failed";
                subcall["error"] = error.Message;
            }
            throw;
        }
        finally
        {
            last["durationMs"] = watch.Elapsed.TotalMilliseconds;
            if (Text(last["status"]) == "running")
                last["status"] = "completed";
            if (subcall is not null)
            {
                subcall["durationMs"] = watch.Elapsed.TotalMilliseconds;
                if (Text(subcall["status"]) == "running")
                    subcall["status"] = "completed";
                Emit();
            }
        }
        void Emit()
        {
            var data = record["subCalls"] as JsonArray;
            if (data is null)
                return;
            budget.JsonValue(data);
            context.Progress?.Invoke((JsonArray)data.DeepClone());
        }
    }

    private static readonly HashSet<string> Metadata = new(
        ["toolId", "source", "name", "server", "nodeId", "args"],
        StringComparer.Ordinal
    );
    private static readonly HashSet<string> NodeNames = new(
        [
            "read",
            "write",
            "edit",
            "apply_patch",
            "image_crop",
            "image_write_to_file",
            "send_file",
            "exec",
            "terminal_open",
            "terminal_send",
            "terminal_read",
            "terminal_resize",
            "terminal_close",
        ],
        StringComparer.Ordinal
    );

    private static JsonObject Wrapper(JsonArray positional, JsonObject kwargs)
    {
        if (positional.Count > 2)
            throw new InvalidDataException("call_tool supports at most two positional arguments.");
        var first = positional.Count > 0 ? positional[0] : null;
        if (first is not null && first is not JsonObject && Text(first) is null)
            throw new InvalidDataException("call_tool requires a tool name or descriptor.");
        JsonObject Mapping(JsonNode? node, bool supplied) =>
            node is JsonObject obj ? obj
            : !supplied ? new()
            : throw new InvalidDataException("call_tool args must be an object.");
        var second = Mapping(positional.Count > 1 ? positional[1] : null, positional.Count > 1);
        var descriptor = first as JsonObject ?? new JsonObject();
        var result = new JsonObject();
        var args = new JsonObject();
        void Copy(JsonObject source, bool metadata)
        {
            foreach (var (key, value) in source)
                if (Metadata.Contains(key) == metadata && key != "args")
                    (metadata ? result : args)[key] = value?.DeepClone();
        }
        void Arguments(JsonObject source)
        {
            foreach (var (key, value) in source)
                args[key] = value?.DeepClone();
        }
        var explicitArgs = Mapping(kwargs["args"], kwargs.ContainsKey("args"));
        if (first is JsonObject)
        {
            Copy(descriptor, true);
            Copy(kwargs, true);
            Copy(descriptor, false);
            Arguments(second);
            Arguments(Mapping(descriptor["args"], descriptor.ContainsKey("args")));
            Copy(kwargs, false);
            Arguments(explicitArgs);
        }
        else
        {
            Copy(kwargs, true);
            if (Text(first) is string name)
                result[name.Contains(':') ? "toolId" : "name"] = name;
            Arguments(second);
            Arguments(explicitArgs);
            Copy(kwargs, false);
        }
        result["args"] = args;
        if (!result.ContainsKey("source") && Text(result["name"]) is string toolName)
            result["source"] = NodeNames.Contains(toolName) ? "node" : "builtin";
        return result;
    }

    private static JsonObject Project(JsonObject record, bool lean, string? stdoutDelta = null)
    {
        _ = new ToolScriptStdout(Text(record["stdout"]) ?? "");
        var budget = new ToolScriptDataBudget();
        budget.JsonValue(record);
        var output = new JsonObject();
        foreach (
            var key in lean ? new[] { "status", "runId" } : new[] { "status", "runId", "mode" }
        )
            output[key] = record[key]?.DeepClone();
        var text = stdoutDelta ?? Text(record["stdout"]) ?? "";
        if (!lean || text.Length > 0)
            output["stdout"] = text;
        if (record.ContainsKey("lastResult") && (!lean || Text(record["status"]) == "completed"))
        {
            output["result"] = record["lastResult"]?.DeepClone();
            if (output["result"] is JsonObject result && result["parts"] is JsonArray parts)
            {
                var images = parts
                    .OfType<JsonObject>()
                    .Where(part =>
                        Foxwarm.Images.ImageBlobStore.NormalizeToolReference(part) is not null
                    )
                    .ToArray();
                if (images.Length > 0)
                {
                    output["imageParts"] = new JsonArray(
                        images.Select(part => part.DeepClone()).ToArray()
                    );
                    var survivors = new JsonArray(
                        parts
                            .Where(part => !images.Contains(part))
                            .Select(part => part?.DeepClone())
                            .ToArray()
                    );
                    foreach (var image in images)
                        if (Text(image["text"]) is { Length: > 0 } imageText)
                            survivors.Add(new JsonObject { ["text"] = imageText });
                    var placeholder = $"[{images.Length} image part(s) promoted]";
                    if (survivors.Count > 0)
                    {
                        survivors.Add(placeholder);
                        result["parts"] = survivors;
                    }
                    else
                        result["parts"] = placeholder;
                }
            }
        }
        if (record.ContainsKey("error"))
            output["error"] = record["error"]?.DeepClone();
        if (Text(record["status"]) == "waiting" && record["waiting"] is JsonObject waiting)
        {
            output["waitingReason"] = waiting["reason"]?.DeepClone();
            foreach (var key in new[] { "continuationId", "question" })
                if (waiting.ContainsKey(key))
                    output[key] = waiting[key]?.DeepClone();
        }
        if (!lean)
            foreach (
                var key in new[]
                {
                    "ownerSessionId",
                    "agentName",
                    "scriptPath",
                    "filePath",
                    "vmRuntime",
                    "executedTools",
                    "subCalls",
                    "hostCallCount",
                    "lastHostCall",
                    "relatedManagedSessions",
                    "timeoutSecs",
                    "createdAt",
                    "updatedAt",
                    "startedAt",
                    "completedAt",
                    "cancelledAt",
                }
            )
                if (record.ContainsKey(key))
                    output[key] = record[key]?.DeepClone();
        return output;
    }
}
