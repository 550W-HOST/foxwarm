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
        // The Session's Node and cwd once each call settled, including a cwd it changed.
        var placements = new (string Node, string? Cwd)?[planned.Count];
        (string Node, string? Cwd)? Placement() =>
            tools is SessionToolExecutor executor ? executor.SessionPlacement : null;
        var cursor = 0;
        var selectionFailed = false;
        while (cursor < planned.Count)
        {
            if (selectionFailed)
            {
                results[cursor++] = new(
                    ToolFailure.Result(
                        "Tool call was not started because Node selection failed.",
                        "tool_call_skipped"
                    )
                );
                continue;
            }
            if (SessionWait.Text(planned[cursor].Call["name"]) != "exec")
            {
                results[cursor] = await ExecutePlannedToolAsync(
                        planned[cursor],
                        token,
                        index: cursor,
                        total: planned.Count
                    )
                    .ConfigureAwait(false);
                placements[cursor] = Placement();
                if (
                    IsNodeSelection(planned[cursor].Call)
                    && !SelectionSucceeded(results[cursor]!.Response)
                )
                    selectionFailed = true;
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
                        || Closing
                    )
                        continue;
                    preparation[index - start] = await preparing
                        .PrepareDirectExecAsync(value.Call, token)
                        .ConfigureAwait(false);
                }
            if (tools is SessionToolExecutor settling)
                await settling.SettleApprovalsAsync(preparation, token).ConfigureAwait(false);
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
                            preparation[index - start],
                            index,
                            planned.Count
                        )
                        .ConfigureAwait(false);
                }
            }
            var workers = Enumerable
                .Range(0, Math.Min(4, end - start))
                .Select(_ => WorkAsync())
                .ToArray();
            await Task.WhenAll(workers).ConfigureAwait(false);
            for (var index = start; index < end; index++)
            {
                if (tools is SessionToolExecutor replay)
                    results[index] = await replay.ReplayCwdAsync(results[index]!);
                placements[index] = Placement();
            }
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
            if (result.Target is { } target)
            {
                var meta = response["__meta"] as JsonObject ?? new JsonObject();
                meta["target"] = target.DeepClone();
                response["__meta"] = meta;
            }
            // Display base for file links the model writes after this call: the Session's Node
            // and cwd once the call settled, including a cwd the call itself changed.
            if (placements[index] is { } after)
            {
                var meta = response["__meta"] as JsonObject ?? new JsonObject();
                var value = new JsonObject { ["node"] = after.Node };
                if (after.Cwd is { Length: > 0 } cwd)
                    value["cwd"] = cwd;
                meta["placementAfter"] = value;
                response["__meta"] = meta;
            }
            if (result.ExecPlacement is { } placement)
            {
                var meta = response["__meta"] as JsonObject ?? new JsonObject();
                meta["exec"] = placement.DeepClone();
                response["__meta"] = meta;
            }
            if (result.Approval is { } approval)
            {
                var meta = response["__meta"] as JsonObject ?? new JsonObject();
                meta["approval"] = approval.DeepClone();
                response["__meta"] = meta;
            }
            if (result.SessionMessages is { Count: > 0 } deliveries)
            {
                var meta = response["__meta"] as JsonObject ?? new JsonObject();
                meta["sessionMessages"] = deliveries.DeepClone();
                response["__meta"] = meta;
            }
            if (result.ToolScriptSubCalls is { } scriptCalls)
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
                    response["response"] = ToolFailure.Result(
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
        if (name == "node")
            return SessionWait
                    .Text(args?["action"])
                    ?.Trim()
                    .Equals("select", StringComparison.OrdinalIgnoreCase) == true;
        return name == "ctl" && args is not null && CtlParser.SelectsNode(args);
    }

    private static bool SelectionSucceeded(JsonNode? result) =>
        result is JsonObject value
        && value["error"] is null
        && value["canceled"]?.GetValue<bool>() != true
        && SessionWait.Text(value["nodeId"]) is { Length: > 0 };

    private async Task<TurnToolExecution> ExecutePlannedToolAsync(
        (JsonObject Call, JsonObject? Preset) planned,
        CancellationToken token,
        TurnToolPreparation? prepared = null,
        int? index = null,
        int? total = null
    )
    {
        var call = planned.Call;
        // A prepared approval of a call skipped before it starts ends with the call.
        Task<TurnToolExecution> Skipped(TurnToolExecution value) =>
            tools is SessionToolExecutor approving
                ? approving.SkippedPrepared(value, prepared, token)
                : Task.FromResult(value);
        if (token.IsCancellationRequested || Closing)
            return await Skipped(
                new(
                    new JsonObject
                    {
                        ["canceled"] = true,
                        ["error"] =
                            $"Tool call was not started because {(Closing && !entry.WithState(state => state.Stopping) ? "process shutdown" : entry.ToolCancellationSource)} cancelled it; it was not executed.",
                        ["code"] = "tool_call_cancelled",
                    }
                )
            );
        if (planned.Preset is JsonObject preset)
            return new((JsonObject)preset.DeepClone());
        if (tools is ITurnToolControl fatal && fatal.PolicyUnavailable)
            return await Skipped(
                new(
                    ToolFailure.Result(
                        "Tool call was not started because tool authorization policy was unavailable.",
                        "tool_call_skipped"
                    )
                )
            );
        if (
            call["argsParseError"] is JsonValue parse
            && parse.TryGetValue<string>(out var error)
            && error.Length > 0
        )
        {
            if (tools is SessionToolExecutor malformed)
                malformed.BroadcastVerboseToolStart(call);
            if (
                SessionWait.Text(call["name"]) == "submit_compact_plan"
                && tools is SessionToolExecutor compact
            )
                return await compact.ExecuteAttributedAsync(
                    (JsonObject)call.DeepClone(),
                    token,
                    index,
                    total
                );
            return new(ToolFailure.Result(error));
        }
        if (prepared?.Response is not null && tools is SessionToolExecutor executor)
            return executor.PreparedFailure(prepared);
        entry.ToolProgress?.Invoke(call, true);
        try
        {
            var owned = (JsonObject)call.DeepClone();
            return tools is SessionToolExecutor current
                ? await current
                    .ExecuteAttributedAsync(owned, token, index, total, approved: prepared)
                    .ConfigureAwait(false)
                : new(await tools.ExecuteAsync(owned, token).ConfigureAwait(false));
        }
        catch (OperationCanceledException)
        {
            return new(
                ToolFailure.Result(
                    $"Tool request canceled by {entry.ToolCancellationSource} after dispatch. Started effects may have occurred and were not reversed.",
                    "tool_call_cancelled"
                )
            );
        }
        catch (Exception exception)
            when (exception is InvalidOperationException or IOException or ArgumentException)
        {
            return new(ToolFailure.Result(exception.Message));
        }
        finally
        {
            entry.ToolProgress?.Invoke(call, false);
        }
    }
}
