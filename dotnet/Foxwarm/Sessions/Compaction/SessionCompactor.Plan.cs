using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

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
        async Task<string> ResolvePrompt(ConcreteHostModel leaf, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            if (ConditionalMemory.ReadCurrentModelSnapshotId(promptSnapshot) != leaf.Key)
                promptSnapshot = await memory.BuildAsync(hosted.Agent, hosted.Id, leaf.Key, token);
            return baseOptions.Instructions.Length == 0 ? promptSnapshot : baseOptions.Instructions + "\n\n" + promptSnapshot;
        }
        for (var round = 0; round < 15; round++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            detached.Add(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["system"] = prompt }) });
            var catalog = models.Capture();
            ChatResult result;
            try { result = await requests.RequestAsync(hosted.Id, catalog, routeKey, rawEffort, cacheKey, turnId, detached,
                ResolvePrompt, null, null, null, hosted.Entry.RecordBestEffortFailure, cancellationToken, scope); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
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
            if (calls.Length != 1 || wrongName is not null)
            {
                prompt = CompactPrompt.InvalidTool(wrongName, calls.Length);
                AppendRejectedCalls(detached, calls, prompt);
                continue;
            }
            try
            {
                if (calls[0]?["argsParseError"] is JsonNode)
                    throw new CompactPlanInvalidException("submit_compact_plan arguments must be valid JSON.");
                return CompactPlanValidator.Validate(calls[0]?["args"] as JsonObject ?? new JsonObject(), candidates);
            }
            catch (CompactPlanInvalidException error)
            {
                prompt = CompactPrompt.InvalidPlan(error.Message);
                AppendRejectedCalls(detached, calls, prompt);
            }
        }
        throw new InvalidDataException("Compaction skipped after 15 compact planning round(s) because no valid plan was produced via submit_compact_plan.");
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
