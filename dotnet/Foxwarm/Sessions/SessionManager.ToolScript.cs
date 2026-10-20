using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Tools;
using Foxwarm.ToolScript;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal void RequireMainFileSourcePath(SessionOwner owner, string path)
    {
        if (!AgentIsolated(owner.Agent))
            return;
        var own = AuthorizationPaths.CanonicalPotential(agents.AgentDirectory(owner.Agent));
        var actual = AuthorizationPaths.CanonicalPotential(path);
        if (
            !ToolAuthorizationEvaluation.Within(actual, own)
            || owner.Agent == "main"
                && agents.AgentDirectory("main") == toolWorkspace
                && ToolAuthorizationEvaluation.Within(
                    actual,
                    AuthorizationPaths.CanonicalPotential(Path.Combine(own, "agents"))
                )
        )
            throw new ToolAuthorizationDeniedException(
                "Isolated Agent can only read source files within its own directory."
            );
    }

    internal async Task<JsonNode?> NormalizeToolScriptResultAsync(
        JsonNode? value,
        string name,
        ToolScriptDataBudget budget,
        CancellationToken token
    )
    {
        budget.JsonValue(value);
        var response = new JsonObject
        {
            ["tool_use_id"] = "toolscript-" + Guid.NewGuid().ToString("N"),
            ["name"] = name,
            ["response"] = value?.DeepClone(),
        };
        var message = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(new JsonObject { ["functionResponse"] = response }),
        };
        token.ThrowIfCancellationRequested();
        await Images.ExternalizeMessageAsync(message);
        var envelope = message["parts"]![0]!["functionResponse"]!.AsObject();
        var result = envelope["response"];
        var images = message["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .Where(part => part.ContainsKey("inlineDataRef"))
            .ToArray();
        if (images.Length > 0 && result is JsonObject obj)
        {
            var parts = obj["parts"] as JsonArray ?? new JsonArray();
            foreach (var image in images)
                parts.Add(image.DeepClone());
            obj["parts"] = parts;
        }
        envelope.Remove("response");
        return result;
    }

    internal async Task<JsonObject> RequestToolScriptModelAsync(
        SessionOwner owner,
        string prompt,
        string? model,
        ToolScriptDataBudget budget,
        CancellationToken token
    )
    {
        await WaitForIdentityMutationAsync(owner.Id, token);
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "ToolScript model caller is no longer the current owner."
            );
        if (model is "")
            model = null;
        var snapshot = owner.Entry.Snapshot();
        var catalog = models.Capture();
        var selection = catalog.Select(snapshot);
        var route =
            model
            ?? (
                selection.RawModel is not null && catalog.Contains(selection.RawModel)
                    ? selection.RawModel
                    : catalog.DefaultKey
            );
        if (model is not null && !catalog.Contains(model))
            throw new InvalidDataException("Unknown model: " + model);
        var requests = new ModelRequestOwner(
            http,
            clientOptions,
            modelRouting,
            websockets: websockets,
            images: Images,
            journal: Journal
        );
        var captured = requests.Capture(catalog, route, selection.RawEffort);
        var cache = await owner.Entry.SaveLane.EnsurePromptCacheKeyAsync();
        var result = await requests.RequestAsync(
            owner.Id,
            captured,
            cache,
            owner.LogicalTurnId,
            [
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = prompt }),
                },
            ],
            (_, _) => Task.FromResult(""),
            null,
            () => { },
            null,
            owner.Entry.RecordBestEffortFailure,
            token,
            ModelRequestScope.LowLevel,
            () => new JsonArray(),
            null,
            "toolscript-one-shot",
            0
        );
        if (result.AssistantMessage is not null)
            budget.JsonValue(result.AssistantMessage);
        result.FinalizeHistory(null); // Detached result is not an accepted normal-history prefix.
        var message =
            result.AssistantMessage
            ?? new JsonObject { ["role"] = "model", ["parts"] = new JsonArray() };
        await Images.ExternalizeMessageAsync(message);
        return ProjectToolScriptModelMessage(message, budget);
    }

    internal static JsonObject ProjectToolScriptModelMessage(
        JsonObject message,
        ToolScriptDataBudget budget
    )
    {
        budget.JsonValue(message);
        var parts = new JsonArray();
        var text = new System.Text.StringBuilder();
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (
                part["thinking"] is not null
                || part["functionCall"] is not null
                || part["functionResponse"] is not null
            )
                continue;
            var projected = new JsonObject();
            if (SessionWait.Text(part["text"]) is string content)
            {
                projected["text"] = content;
                text.Append(content);
            }
            if (Foxwarm.Images.ImageBlobStore.NormalizeToolReference(part) is JsonObject reference)
                projected["inlineDataRef"] = reference.DeepClone();
            if (projected.Count > 0)
                parts.Add(projected);
        }
        return new JsonObject { ["text"] = text.ToString(), ["parts"] = parts };
    }
}
