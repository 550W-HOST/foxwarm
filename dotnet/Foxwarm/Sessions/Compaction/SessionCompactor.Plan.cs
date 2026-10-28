using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCompactor
{
    private async Task<CompactPlan> PlanAsync(
        SessionSnapshot snapshot,
        CompactCandidates candidates,
        string? guidance,
        CancellationToken cancellationToken,
        string cacheKey,
        ModelRequestScope scope,
        string capturedDefault,
        CompactRun? run = null
    )
    {
        var detached = snapshot
            .History.Take(Math.Max(0, candidates.Split))
            .Select(row => row.ToJson())
            .ToList();
        var plannerHistoryStart = detached.Count;
        var plannerToolCalls = new List<string>();
        JsonObject? plannerUsage = null;
        var prompt = CompactPrompt.Build(candidates, guidance);
        var promptSnapshot =
            snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "";
        var routeKey = SessionWait.Text(snapshot.AuthorityEnvelope["model"]) ?? capturedDefault;
        var rawEffort = SessionWait.Text(snapshot.AuthorityEnvelope["effort"]);
        var turnId = Guid.NewGuid().ToString();
        CompactPlanRepairFile? repairFile = null;
        async Task<string> ResolvePrompt(ConcreteHostModel leaf, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (ConditionalMemory.ReadCurrentModelSnapshotId(promptSnapshot) != leaf.Key)
                promptSnapshot = await memory.BuildAsync(
                    hosted.Agent,
                    hosted.Id,
                    leaf.Key,
                    token,
                    AgentMemory.Selection(snapshot.AuthorityEnvelope)
                );
            return baseOptions.Instructions.Length == 0
                ? promptSnapshot
                : baseOptions.Instructions + "\n\n" + promptSnapshot;
        }
        try
        {
            for (var round = 0; round < 15; round++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                detached.Add(
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["system"] = prompt }),
                    }
                );
                var catalog = models.Capture();
                ChatResult result;
                try
                {
                    result = await requests.RequestAsync(
                        hosted.Id,
                        catalog,
                        routeKey,
                        rawEffort,
                        cacheKey,
                        turnId,
                        detached,
                        ResolvePrompt,
                        value =>
                        {
                            if (run is not null)
                            {
                                lock (gate)
                                    run.Retry = SessionOwner.RetryProjection(value);
                                PublishRuntime(run);
                            }
                            return Task.FromResult(false);
                        },
                        () =>
                        {
                            if (run is not null)
                            {
                                lock (gate)
                                    run.Retry = null;
                                PublishRuntime(run);
                            }
                        },
                        null,
                        hosted.Entry.RecordBestEffortFailure,
                        cancellationToken,
                        scope,
                        definitions,
                        null,
                        "compact-plan",
                        round
                    );
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Foxwarm.Tools.ToolAuthorizationUnavailableException)
                {
                    throw;
                }
                catch (ModelRequestException)
                {
                    throw;
                }
                catch (Exception error)
                {
                    throw new ModelPreparationException(
                        ConfiguredModelRequests.SafeError(error, catalog.Resolve(routeKey)),
                        error
                    );
                }
                var assistant = result.AssistantMessage;
                try
                {
                    if (assistant is not null)
                    {
                        var appended = (JsonObject)assistant.DeepClone();
                        detached.Add(appended);
                        result.FinalizeHistory([appended], hosted.Entry.RecordBestEffortFailure);
                    }
                }
                finally
                {
                    result.FinalizeHistory(null, hosted.Entry.RecordBestEffortFailure);
                }
                var calls =
                    (assistant?["parts"] as JsonArray)
                        ?.OfType<JsonObject>()
                        .Select(part => part["functionCall"] as JsonObject)
                        .Where(call => call is not null)
                        .ToArray()
                    ?? [];
                plannerToolCalls.AddRange(calls.Select(call => call!["name"]!.GetValue<string>()));
                var usage = result.Usage ?? assistant?["__meta"]?["usage"] as JsonObject;
                if (usage is not null)
                    plannerUsage = CompactionPlannerDebug.AddUsage(plannerUsage, usage);
                var wrongName = calls
                    .FirstOrDefault(call =>
                        call?["name"]?.GetValue<string>() != "submit_compact_plan"
                    )
                    ?["name"]?.GetValue<string>();
                if (
                    repairFile is not null
                    && calls.Length == 1
                    && calls[0]?["name"]?.GetValue<string>() is "edit" or "apply_patch"
                )
                {
                    try
                    {
                        var controlled = ToolCallControls.Plan([calls[0]!])[0];
                        if (controlled.Preset is not null)
                        {
                            var canceled = controlled.Preset["canceled"]?.GetValue<bool>() == true;
                            var presetType = SessionWait.Text(controlled.Preset["error"]?["type"]);
                            var presetMessage =
                                SessionWait.Text(controlled.Preset["message"])
                                ?? SessionWait.Text(controlled.Preset["error"]?["message"]);
                            AppendToolFeedback(
                                detached,
                                calls[0]!,
                                canceled
                                    ? "Compact repair canceled."
                                    : $"Compact repair failed [{presetType}]: {presetMessage}"
                            );
                        }
                        else
                        {
                            await repairFile.ApplyAsync(controlled.Call, cancellationToken);
                            AppendToolFeedback(
                                detached,
                                calls[0]!,
                                "Compact arguments file updated."
                            );
                        }
                        prompt = RepairInstructions(repairFile);
                    }
                    catch (Exception error)
                        when (error
                                is InvalidDataException
                                    or IOException
                                    or UnauthorizedAccessException
                                    or ArgumentException
                                    or NotSupportedException
                                    or ToolAuthorizationDeniedException
                        )
                    {
                        AppendToolFeedback(
                            detached,
                            calls[0]!,
                            $"Compact repair failed: {error.Message}"
                        );
                        prompt = RepairInstructions(repairFile);
                    }
                    continue;
                }
                if (calls.Length != 1 || wrongName is not null)
                {
                    prompt =
                        CompactPrompt.InvalidTool(wrongName, calls.Length, repairFile is not null)
                        + (repairFile is null ? "" : " " + RepairInstructions(repairFile));
                    AppendRejectedCalls(detached, calls, prompt);
                    continue;
                }
                var submitted = calls[0]!;
                var controlledPlan = ToolCallControls.Plan([submitted])[0];
                if (controlledPlan.Preset is not null)
                {
                    AppendToolFeedback(detached, submitted, controlledPlan.Preset.ToJsonString());
                    continue;
                }
                JsonObject repairInput = submitted;
                var submittedPendingFile = false;
                try
                {
                    var args = CompactPlanInput.Arguments(controlledPlan.Call);
                    if (CompactPlanInput.FilePath(args) is string path)
                    {
                        string text;
                        if (repairFile is not null && path == repairFile.FilePath)
                        {
                            submittedPendingFile = true;
                            text = await repairFile.ReadAsync(path, cancellationToken);
                        }
                        else
                        {
                            var manager =
                                sessions
                                ?? throw new NotSupportedException(
                                    "Plan file input requires a hosted SessionManager."
                                );
                            var placement = manager.ExecutionPlacement(hosted);
                            var files = new CompactPlanFiles(
                                manager,
                                hosted,
                                placement.Node,
                                placement.Cwd,
                                manager.IdentityWorkspace(hosted)
                            );
                            text = await files.ReadAsync(path, cancellationToken);
                        }
                        repairInput = new JsonObject { ["rawArgsText"] = text };
                        args = CompactPlanInput.ParseFile(text);
                    }
                    var plan = CompactPlanValidator.Validate(args, candidates);
                    var messages = new JsonArray();
                    foreach (var message in detached.Skip(plannerHistoryStart))
                    {
                        messages.Add(message.DeepClone());
                    }
                    return plan with
                    {
                        Planner = new CompactionPlannerDebug(
                            round + 1,
                            plannerToolCalls.ToArray(),
                            plannerUsage,
                            messages
                        ),
                    };
                }
                catch (CompactPlanInvalidException error)
                {
                    prompt = PlanRejected(error.Message, repairFile);
                    if (!submittedPendingFile)
                    {
                        try
                        {
                            var replacement = await CompactPlanRepairFile.CreateAsync(
                                repairInput,
                                sessions
                                    ?? throw new NotSupportedException(
                                        "Compact repair requires a hosted SessionManager."
                                    ),
                                hosted,
                                cancellationToken
                            );
                            if (repairFile is not null)
                                await repairFile.DisposeAsync();
                            repairFile = replacement;
                            prompt = PlanRejected(error.Message, repairFile);
                        }
                        catch (Exception saveError)
                            when (saveError
                                    is InvalidDataException
                                        or IOException
                                        or UnauthorizedAccessException
                                        or ArgumentException
                                        or NotSupportedException
                                        or ToolAuthorizationDeniedException
                            )
                        {
                            prompt =
                                PlanRejected(error.Message, null)
                                + " Plan file staging failed: "
                                + saveError.Message;
                        }
                    }
                    AppendRejectedCalls(detached, calls, prompt);
                }
                catch (Exception error)
                    when (error
                            is InvalidDataException
                                or IOException
                                or UnauthorizedAccessException
                                or ArgumentException
                                or NotSupportedException
                                or ToolAuthorizationDeniedException
                    )
                {
                    prompt = "Plan file input failed: " + error.Message;
                    AppendRejectedCalls(
                        detached,
                        calls,
                        prompt,
                        error is ToolAuthorizationDeniedException
                            ? "tool_authorization_denied"
                            : "tool_io_error"
                    );
                }
            }
        }
        finally
        {
            if (repairFile is not null)
                await repairFile.DisposeAsync();
        }
        throw new InvalidDataException(
            "Compaction skipped after 15 compact planning round(s) because no valid plan was produced via submit_compact_plan."
        );
    }

    private static string RepairInstructions(CompactPlanRepairFile? repairFile) =>
        repairFile is null
            ? "Submit corrected direct plan fields with submit_compact_plan."
            : $"{CompactPlanInput.RepairGuidance} Repair the JSON arguments in {JsonSerializer.Serialize(repairFile.FilePath)} (nodeId={JsonSerializer.Serialize(repairFile.Node)}, cwd={JsonSerializer.Serialize(repairFile.Cwd)}) using edit or apply_patch (one update only). Then call submit_compact_plan by itself with {{\"argsFilePath\":{JsonSerializer.Serialize(repairFile.FilePath)}}}. Only this exact file is available for repair; ordinary tool permissions still apply. Current file preview (beginning/end):\n{repairFile.Preview()}\n{(repairFile.StructuredFallback ? "This file was saved by serializing the provider's structured arguments." : "This file was saved from the original provider arguments.")}";

    private static string PlanRejected(string reason, CompactPlanRepairFile? repairFile) =>
        repairFile is null
            ? $"Compact plan rejected; submit corrected direct plan fields. {reason}"
            : $"Compact plan rejected. Repair file: {JsonSerializer.Serialize(repairFile.FilePath)}. {reason} {RepairInstructions(repairFile)}";

    private static void AppendToolFeedback(
        List<JsonObject> history,
        JsonObject call,
        string feedback
    )
    {
        var id = call["id"]?.GetValue<string>();
        if (id is null)
            return;
        history.Add(
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = id,
                            ["name"] = call["name"]?.GetValue<string>() ?? "submit_compact_plan",
                            ["response"] = new JsonObject { ["output"] = feedback },
                        },
                    }
                ),
            }
        );
    }

    private static void AppendRejectedCalls(
        List<JsonObject> history,
        IEnumerable<JsonObject?> calls,
        string feedback,
        string errorType = "compact_plan_invalid"
    )
    {
        var parts = new JsonArray();
        foreach (var call in calls)
        {
            var id = call?["id"]?.GetValue<string>();
            if (id is null)
                continue;
            parts.Add(
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = id,
                        ["name"] = call?["name"]?.GetValue<string>() ?? "submit_compact_plan",
                        ["response"] = new JsonObject
                        {
                            ["error"] = new JsonObject
                            {
                                ["type"] = errorType,
                                ["message"] = feedback,
                            },
                        },
                    },
                }
            );
        }
        if (parts.Count > 0)
            history.Add(new JsonObject { ["role"] = "tool", ["parts"] = parts });
    }
}
