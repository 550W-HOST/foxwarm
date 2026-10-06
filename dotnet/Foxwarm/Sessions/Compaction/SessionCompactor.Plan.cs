using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCompactor
{
    private async Task<CompactPlan> PlanAsync(SessionSnapshot snapshot, CompactCandidates candidates,
        string? guidance, CancellationToken cancellationToken, string cacheKey, ModelRequestScope scope, string capturedDefault)
    {
        var detached = snapshot.History.Take(Math.Max(0, candidates.Split)).Select(row => (JsonObject)row.DeepClone()).ToList();
        var prompt = CompactPrompt.Build(candidates, guidance);
        var promptSnapshot = snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "";
        var routeKey = SessionWait.Text(snapshot.AuthorityEnvelope["model"]) ?? capturedDefault;
        var rawEffort = SessionWait.Text(snapshot.AuthorityEnvelope["effort"]);
        var turnId = Guid.NewGuid().ToString();
        CompactPlanRepairFile? repairFile = null;
        async Task<string> ResolvePrompt(ConcreteHostModel leaf, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (ConditionalMemory.ReadCurrentModelSnapshotId(promptSnapshot) != leaf.Key)
                promptSnapshot = await memory.BuildAsync(hosted.Agent, hosted.Id, leaf.Key, token, AgentMemory.Selection(snapshot.AuthorityEnvelope));
            return baseOptions.Instructions.Length == 0 ? promptSnapshot : baseOptions.Instructions + "\n\n" + promptSnapshot;
        }
        try
        {
            for (var round = 0; round < 15; round++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                detached.Add(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["system"] = prompt }) });
                var catalog = models.Capture();
                ChatResult result;
                try { result = await requests.RequestAsync(hosted.Id, catalog, routeKey, rawEffort, cacheKey, turnId, detached,
                    ResolvePrompt, null, null, null, hosted.Entry.RecordBestEffortFailure, cancellationToken, scope, definitions); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
                catch (Foxwarm.Tools.ToolAuthorizationUnavailableException) { throw; }
                catch (ModelRequestException) { throw; }
                catch (Exception error) { throw new ModelPreparationException(ConfiguredModelRequests.SafeError(error, catalog.Resolve(routeKey)), error); }
                var assistant = result.AssistantMessage;
                try
                {
                if (assistant is not null)
                {
                    var appended = (JsonObject)assistant.DeepClone(); detached.Add(appended);
                    result.FinalizeHistory([appended], hosted.Entry.RecordBestEffortFailure);
                }
                }
                finally { result.FinalizeHistory(null, hosted.Entry.RecordBestEffortFailure); }
                var calls = (assistant?["parts"] as JsonArray)?.OfType<JsonObject>()
                .Select(part => part["functionCall"] as JsonObject).Where(call => call is not null).ToArray() ?? [];
                var wrongName = calls.FirstOrDefault(call => call?["name"]?.GetValue<string>() != "submit_compact_plan")?["name"]?.GetValue<string>();
                if (repairFile is not null && calls.Length == 1 && calls[0]?["name"]?.GetValue<string>() is "edit" or "apply_patch")
                {
                try
                {
                    var controlled = ToolCallControls.Plan([calls[0]!])[0];
                    if (controlled.Preset is not null)
                    {
                        var canceled = controlled.Preset["canceled"]?.GetValue<bool>() == true;
                        AppendToolFeedback(detached, calls[0]!, canceled ? "Compact repair canceled." : $"Compact repair failed: {SessionWait.Text(controlled.Preset["message"])}");
                    }
                    else
                    {
                        await repairFile.ApplyAsync(controlled.Call, cancellationToken);
                        AppendToolFeedback(detached, calls[0]!, "Compact arguments file updated.");
                    }
                    prompt = RepairInstructions(repairFile);
                }
                catch (Exception error) when (error is InvalidDataException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or ToolAuthorizationDeniedException)
                {
                    AppendToolFeedback(detached, calls[0]!, $"Compact repair failed: {error.Message}");
                    prompt = RepairInstructions(repairFile);
                }
                    continue;
                }
                if (calls.Length != 1 || wrongName is not null)
                {
                prompt = CompactPrompt.InvalidTool(wrongName, calls.Length, repairFile is not null) + (repairFile is null ? "" : " " + RepairInstructions(repairFile));
                AppendRejectedCalls(detached, calls, prompt);
                    continue;
                }
                try
                {
                if (calls[0]?["argsParseError"] is JsonNode)
                    throw new CompactPlanInvalidException("submit_compact_plan arguments must be valid JSON.");
                var args = calls[0]?["args"] as JsonObject ?? new JsonObject();
                if (args.ContainsKey("argsFilePath"))
                {
                    if (args.Count != 1 || SessionWait.Text(args["argsFilePath"]) is not string path || path.Length == 0)
                        throw new CompactPlanInvalidException("Supply argsFilePath alone, or direct plan fields without argsFilePath.");
                    if (repairFile is null) throw new CompactPlanInvalidException("No repair file is pending for this compact operation.");
                    string text;
                    try { text = await repairFile.ReadAsync(path, cancellationToken); }
                    catch (Exception readError) when (readError is InvalidDataException or IOException or UnauthorizedAccessException)
                    { throw new CompactPlanInvalidException("The repair file could not be read: " + readError.Message); }
                    JsonObject parsed;
                    try { parsed = JsonNode.Parse(text) as JsonObject ?? throw new CompactPlanInvalidException("The repair file must contain valid JSON with a top-level object."); }
                    catch (JsonException parseError) { throw new CompactPlanInvalidException("The repair file must contain valid JSON: " + parseError.Message); }
                    if (parsed.ContainsKey("argsFilePath")) throw new CompactPlanInvalidException("The repair file must contain direct plan fields, not argsFilePath.");
                    args = parsed;
                }
                return CompactPlanValidator.Validate(args, candidates);
                }
                catch (CompactPlanInvalidException error)
                {
                prompt = PlanRejected(error.Message, repairFile);
                AppendRejectedCalls(detached, calls, prompt);
                var submittedArgs = calls[0]!["args"] as JsonObject;
                if (repairFile is null && submittedArgs?.ContainsKey("argsFilePath") != true)
                {
                    try
                    {
                        repairFile = await CompactPlanRepairFile.CreateAsync(calls[0]!, sessions ?? throw new NotSupportedException("Compact repair requires a hosted SessionManager."), hosted, cancellationToken);
                        prompt = PlanRejected(error.Message, repairFile);
                    }
                    catch (Exception saveError) when (saveError is InvalidDataException or IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
                    { prompt = PlanRejected(saveError.Message, null); }
                }
                }
            }
        }
        finally
        {
            if (repairFile is not null) await repairFile.DisposeAsync();
        }
        throw new InvalidDataException("Compaction skipped after 15 compact planning round(s) because no valid plan was produced via submit_compact_plan.");
    }

    private static string RepairInstructions(CompactPlanRepairFile? repairFile) => repairFile is null
        ? "Submit corrected direct plan fields with submit_compact_plan."
        : $"Repair the JSON arguments in {JsonSerializer.Serialize(repairFile.FilePath)} using edit or apply_patch (one update only). Then call submit_compact_plan by itself with {{\"argsFilePath\":{JsonSerializer.Serialize(repairFile.FilePath)}}}. Only this exact file is available for repair; ordinary tool permissions still apply. {(repairFile.StructuredFallback ? "This file was saved by serializing the provider's structured arguments." : "This file was saved from the original provider arguments.")}";

    private static string PlanRejected(string reason, CompactPlanRepairFile? repairFile) => repairFile is null
        ? $"Compact plan rejected; submit corrected direct plan fields. {reason}"
        : $"Compact plan rejected. Repair file: {JsonSerializer.Serialize(repairFile.FilePath)}. {reason} {RepairInstructions(repairFile)}";

    private static void AppendToolFeedback(List<JsonObject> history, JsonObject call, string feedback)
    {
        var id = call["id"]?.GetValue<string>(); if (id is null) return;
        history.Add(new JsonObject { ["role"] = "tool", ["parts"] = new JsonArray(new JsonObject { ["functionResponse"] = new JsonObject
        {
            ["tool_use_id"] = id, ["name"] = call["name"]?.GetValue<string>() ?? "submit_compact_plan", ["response"] = new JsonObject { ["output"] = feedback }
        } }) });
    }

    private static void AppendRejectedCalls(List<JsonObject> history, IEnumerable<JsonObject?> calls, string feedback)
    {
        var parts = new JsonArray();
        foreach (var call in calls)
        {
            var id = call?["id"]?.GetValue<string>();
            if (id is null) continue;
            parts.Add(new JsonObject { ["functionResponse"] = new JsonObject
            {
                ["tool_use_id"] = id, ["name"] = call?["name"]?.GetValue<string>() ?? "submit_compact_plan",
                ["response"] = new JsonObject { ["error"] = new JsonObject
                {
                    ["type"] = "compact_plan_invalid", ["message"] = feedback
                } }
            } });
        }
        if (parts.Count > 0) history.Add(new JsonObject { ["role"] = "tool", ["parts"] = parts });
    }
}
