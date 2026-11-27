using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Tools;
using Foxwarm.ToolScript;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonNode?> NormalizeToolScriptResultAsync(
        JsonNode? value,
        string name,
        ToolScriptDataBudget budget,
        Action<string>? imageProduced = null
    )
    {
        budget.JsonValue(value);
        var response = new JsonObject
        {
            ["tool_use_id"] = "toolscript-" + Guid.NewGuid().ToString("N"),
            ["name"] = name,
            ["response"] = value?.DeepClone(),
        };
        // Script results reach the model; audit evidence in nested messages does not.
        InputSender.Strip(response["response"]);
        var message = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(new JsonObject { ["functionResponse"] = response }),
        };
        // The host call already settled. Deliver its real result before the next admission fence.
        await Images.ExternalizeMessageAsync(message);
        var envelope = message["parts"]![0]!["functionResponse"]!.AsObject();
        var result = envelope["response"];
        var images = message["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .Where(part => part.ContainsKey("inlineDataRef"))
            .ToArray();
        // Only the parts externalized from the response are image results of the call.
        if (imageProduced is not null)
            foreach (var image in images)
                if (
                    Foxwarm.Images.ImageBlobStore.NormalizeToolReference(image) is { } reference
                    && SessionWait.Text(reference["blobId"]) is { Length: > 0 } blob
                )
                    imageProduced(blob);
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

    /// <summary>
    /// Reports the end of a detached background ToolScript segment to its owner Session, once,
    /// like a background exec completion. The run ID is the wait source.
    /// </summary>
    internal Task DeliverToolScriptRunEventAsync(
        SessionOwner owner,
        JsonObject outcome,
        string segment
    )
    {
        var runId = SessionWait.Text(outcome["runId"]) ?? "";
        return CommitBackgroundEventAsync(
            owner,
            runId,
            ToolScriptRunEvent(outcome),
            "toolscript-run:" + runId + ":" + segment
        );
    }

    private const int ToolScriptEventValueLimit = 1000;

    internal static string ToolScriptRunEvent(JsonObject outcome)
    {
        static string Bounded(string text) =>
            text.Length <= ToolScriptEventValueLimit
                ? text
                : text[..ToolScriptEventValueLimit] + "… [truncated]";
        static string Line(string text) => Bounded(text).Replace("\r", "").Replace("\n", "\n  ");
        var status = SessionWait.Text(outcome["status"]) ?? "failed";
        var waiting = status == "waiting";
        var text = new System.Text.StringBuilder()
            .Append("<foxwarm-system kind=\"event\" type=\"")
            .Append(waiting ? "background-script-waiting" : "background-script-finished")
            .Append("\">\n")
            .Append("runId: ")
            .Append(SessionWait.Text(outcome["runId"]))
            .Append("\nstatus: ")
            .Append(status);
        if (waiting)
        {
            text.Append("\ncontinuationId: ").Append(SessionWait.Text(outcome["continuationId"]));
            if (SessionWait.Text(outcome["question"]) is { } question)
                text.Append("\nquestion: ").Append(Line(question));
            text.Append("\nResume it with continue_script using runId, continuationId and input.");
        }
        else
        {
            if (outcome.ContainsKey("result"))
                text.Append("\nresult: ")
                    .Append(
                        Line(
                            SessionWait.Text(outcome["result"])
                                ?? (
                                    outcome["result"] is { } value
                                        ? EcmaJson.Stringify(value)
                                        : "null"
                                )
                        )
                    );
            if (SessionWait.Text(outcome["error"]) is { } error)
                text.Append("\nerror: ").Append(Line(error));
            text.Append("\nget_toolscript_run returns the full output and result.");
        }
        return text.Append("\n</foxwarm-system>").ToString();
    }

    // The catalog key a ToolScript model request resolves to: the named model, else the Session's
    // selection when the catalog has it, else the default.
    internal string ToolScriptModelKey(SessionOwner owner, string? model)
    {
        if (model is "")
            model = null;
        var catalog = models.Capture();
        if (model is not null && !catalog.Contains(model))
            throw new InvalidDataException("Unknown model: " + model);
        var selection = catalog.Select(owner.Entry.Snapshot());
        return model
            ?? (
                selection.RawModel is not null && catalog.Contains(selection.RawModel)
                    ? selection.RawModel
                    : catalog.DefaultKey
            );
    }

    // A ToolScript model request is the operation model.request of the resolved model, assessed
    // as the invocation that runs the slice (its identity and raw arguments): version-1 rules
    // match that invocation, operation rules the operation. SliceAsk is set when every asking
    // rule is a version-1 rule, which an approval of the slice answers once per slice.
    internal sealed record ModelRequestCheck(
        AuthorizationAssessment Assessment,
        string Fingerprint,
        string SliceFingerprint,
        bool SliceAsk
    );

    internal async Task<ModelRequestCheck> AssessToolScriptModelAsync(
        SessionOwner owner,
        ResolvedTool slice,
        WorkspaceTools? files,
        string model,
        CancellationToken token
    )
    {
        var assessment = await AssessToolAsync(
            owner,
            slice,
            files,
            token,
            operations:
            [
                new AuthorizationOperation(
                    "model.request",
                    new JsonObject { ["model"] = model },
                    []
                ),
            ]
        );
        var asking = assessment.Asking.SelectMany(layer => layer.Decision.AskingRules).ToArray();
        // The slice's own approval binds the operations the dispatch gate derived for it (none
        // without operation rules, none for an inline script), so compare with the same.
        var sliceRequest = assessment.Request with { Operations = null };
        if (assessment.Layers.Any(layer => layer.Policy.HasOperationRules))
            sliceRequest = sliceRequest with
            {
                Operations = AuthorizationOperations(owner, slice, sliceRequest, files),
            };
        return new(
            assessment,
            ApprovalFingerprint(owner, slice, assessment.Request),
            ApprovalFingerprint(owner, slice, sliceRequest),
            asking.Length > 0 && !asking.Any(OperationRules.IsOperationRule)
        );
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
            Capabilities.Egress,
            websockets: websockets,
            images: Images,
            journal: Journal,
            diagnostics: diagnostics,
            retryIntervals: models.GetRetryIntervals,
            secrets: secrets
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
