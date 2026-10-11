using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

public sealed partial class LocalSessionTurnHost
{
    private static JsonNode ModelToolResponse(JsonNode? value) =>
        value is JsonObject or JsonArray
            ? value.DeepClone()
            : new JsonObject { ["output"] = value?.DeepClone() };

    private async Task<JsonArray> ExecuteToolBatchAsync(
        IReadOnlyList<(JsonObject Call, JsonObject? Preset)> planned,
        CancellationToken token
    )
    {
        var results = new TurnToolExecution?[planned.Count];
        var cursor = 0;
        var selectionFailed = false;
        while (cursor < planned.Count)
        {
            if (selectionFailed)
            {
                results[cursor++] = new(UnsupportedTurnToolExecutor.ToolError("tool_call_skipped", "Tool call was not started because Node selection failed."));
                continue;
            }
            if (SessionWait.Text(planned[cursor].Call["name"]) != "exec")
            {
                results[cursor] = await ExecutePlannedToolAsync(planned[cursor], token)
                    .ConfigureAwait(false);
                if (IsNodeSelection(planned[cursor].Call) && !SelectionSucceeded(results[cursor]!.Response)) selectionFailed = true;
                cursor++;
                continue;
            }
            var start = cursor;
            while (
                cursor < planned.Count && SessionWait.Text(planned[cursor].Call["name"]) == "exec"
            )
                cursor++;
            var end = cursor;
            var next = start - 1;
            // Preserve declared execution context. An absent/blank cwd leaves Agent defaults
            // to each call's current binding; already-started effects retain their resolved environment.
            using var environment = tools is SessionToolExecutor current
                ? current.CaptureDirectExecSegment()
                : null;
            var preparation = new TurnToolPreparation?[end - start];
            if (tools is SessionToolExecutor preparing)
                for (var index = start; index < end; index++)
                {
                    var value = planned[index];
                    if (
                        value.Preset is not null
                        || value.Call["argsParseError"] is not null
                        || token.IsCancellationRequested
                    )
                        continue;
                    preparation[index - start] = await preparing
                        .PrepareDirectExecAsync(value.Call, token)
                        .ConfigureAwait(false);
                }
            async Task WorkAsync()
            {
                while (true)
                {
                    var index = Interlocked.Increment(ref next);
                    if (index >= end)
                        return;
                    results[index] = await ExecutePlannedToolAsync(
                            planned[index],
                            token,
                            preparation[index - start]
                        )
                        .ConfigureAwait(false);
                }
            }
            var workers = Enumerable
                .Range(0, Math.Min(4, end - start))
                .Select(_ => WorkAsync())
                .ToArray();
            await Task.WhenAll(workers).ConfigureAwait(false);
            if (tools is SessionToolExecutor replay)
                for (var index = start; index < end; index++)
                    results[index] = await replay.ReplayCwdAsync(results[index]!);
        }
        var parts = new JsonArray();
        for (var index = 0; index < planned.Count; index++)
        {
            var call = planned[index].Call;
            var result =
                results[index]
                ?? throw new InvalidOperationException("Tool segment did not settle its call.");
            var response = new JsonObject
            {
                ["tool_use_id"] =
                    SessionWait.Text(call["id"])
                    ?? throw new InvalidOperationException(
                        "Canonical function call is missing its stable ID."
                    ),
                ["name"] = SessionWait.Text(call["name"]) ?? "",
                ["response"] = ModelToolResponse(result.Response),
            };
            if (result.Timing is not null)
                response["executionTiming"] = result.Timing.DeepClone();
            if (
                (result.Response as JsonObject)?["error"] is null
                && result.ResolvedPaths is { Count: > 0 } paths
            )
                response["__meta"] = new JsonObject { ["resolvedPaths"] = paths.DeepClone() };
            if (result.ToolScriptSubCalls is { Count: > 0 } scriptCalls)
            {
                var meta = response["__meta"] as JsonObject ?? new JsonObject();
                meta["toolScriptSubCalls"] = scriptCalls.DeepClone();
                response["__meta"] = meta;
            }
            var wrapper = new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(new JsonObject { ["functionResponse"] = response }),
            };
            if (store is PersistentSessionAuthorityStore persistent)
            {
                try
                {
                    await persistent.Images.ExternalizeMessageAsync(wrapper);
                }
                catch (Foxwarm.Images.ImageInputException error)
                {
                    response["response"] = UnsupportedTurnToolExecutor.ToolError(
                        "image_materialization_failed",
                        error.Message + " The tool call completed; its effects were not reversed."
                    );
                    response.Remove("__meta");
                    wrapper["parts"] = new JsonArray(
                        new JsonObject { ["functionResponse"] = response.DeepClone() }
                    );
                }
            }
            foreach (var part in wrapper["parts"]!.AsArray())
                parts.Add(part!.DeepClone());
        }
        return parts;
    }

    private static bool IsNodeSelection(JsonObject call)
    {
        var name = SessionWait.Text(call["name"]);
        var args = call["args"] as JsonObject;
        if (name == "node") return SessionWait.Text(args?["action"])?.Trim().Equals("select", StringComparison.OrdinalIgnoreCase) == true;
        if (name != "call_tool" || args is null) return false;
        if (SessionWait.Text(args["toolId"]) != "builtin:node" && !(SessionWait.Text(args["source"]) == "builtin" && SessionWait.Text(args["name"]) == "node")) return false;
        try
        {
            var target = ToolRegistry.ObjectArg(args, "args", "argsJson");
            return SessionWait.Text(target?["action"])?.Trim().Equals("select", StringComparison.OrdinalIgnoreCase) == true;
        }
        catch (Exception error) when (error is InvalidDataException or System.Text.Json.JsonException) { return false; }
    }
    private static bool SelectionSucceeded(JsonNode? result) => result is JsonObject value && value["error"] is null && value["canceled"]?.GetValue<bool>() != true && SessionWait.Text(value["nodeId"]) is { Length: > 0 };

    private async Task<TurnToolExecution> ExecutePlannedToolAsync(
        (JsonObject Call, JsonObject? Preset) planned,
        CancellationToken token,
        TurnToolPreparation? prepared = null
    )
    {
        var call = planned.Call;
        if (token.IsCancellationRequested)
            return new(
                new JsonObject
                {
                    ["canceled"] = true,
                    ["message"] = "Tool call canceled before execution.",
                }
            );
        if (planned.Preset is JsonObject preset)
            return new((JsonObject)preset.DeepClone());
        if (tools is ITurnToolControl fatal && fatal.PolicyUnavailable)
            return new(
                UnsupportedTurnToolExecutor.ToolError(
                    "tool_call_skipped",
                    "Tool call was not started because tool authorization policy was unavailable."
                )
            );
        if (
            call["argsParseError"] is JsonValue parse
            && parse.TryGetValue<string>(out var error)
            && error.Length > 0
        )
            return new(UnsupportedTurnToolExecutor.ToolError("invalid_tool_arguments", error));
        if (prepared is not null && tools is SessionToolExecutor executor)
            return executor.PreparedFailure(prepared);
        try
        {
            var owned = (JsonObject)call.DeepClone();
            return tools is SessionToolExecutor current
                ? await current.ExecuteAttributedAsync(owned, token).ConfigureAwait(false)
                : new(await tools.ExecuteAsync(owned, token).ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            return new(
                UnsupportedTurnToolExecutor.ToolError(
                    "tool_call_cancelled",
                    "Tool request canceled. Started effects may have occurred and were not reversed."
                )
            );
        }
        catch (Exception exception)
            when (exception is InvalidOperationException or IOException or ArgumentException)
        {
            return new(UnsupportedTurnToolExecutor.ToolError("tool_error", exception.Message));
        }
    }
}
