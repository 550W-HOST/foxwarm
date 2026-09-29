using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Sessions;

internal sealed partial class SessionCompactor
{
    private async Task<CompactPlan> PlanAsync(SessionSnapshot snapshot, CompactCandidates candidates,
        string? guidance, CancellationToken cancellationToken)
    {
        var detached = snapshot.History.Select(row => (JsonObject)row.DeepClone()).ToList();
        var prompt = CompactPrompt.Build(candidates, guidance);
        var promptSnapshot = snapshot.AuthorityEnvelope["persistentMemorySnapshot"]?.GetValue<string>() ?? "";
        for (var round = 0; round < 15; round++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            detached.Add(new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["system"] = prompt }) });
            var selected = models.Select(hosted.Entry.Snapshot());
            if (ConditionalMemory.ReadCurrentModelSnapshotId(promptSnapshot) != selected.Model.Key)
                promptSnapshot = await memory.BuildAsync(hosted.Agent, hosted.Id, selected.Model.Key);
            var options = baseOptions with
            {
                BaseUri = selected.Model.BaseUri,
                RequestModel = selected.Model.ModelId,
                ConcreteModelId = selected.Model.Key,
                Token = selected.Model.Token,
                Effort = selected.EffectiveEffort,
                Instructions = baseOptions.Instructions.Length == 0 ? promptSnapshot
                    : baseOptions.Instructions + "\n\n" + promptSnapshot
            };
            var service = new ResponsesChatService(http, options);
            var result = await service.ChatAsync(hosted.Id, detached, cancellationToken);
            var assistant = result.AssistantMessage;
            if (assistant is not null) detached.Add((JsonObject)assistant.DeepClone());
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
