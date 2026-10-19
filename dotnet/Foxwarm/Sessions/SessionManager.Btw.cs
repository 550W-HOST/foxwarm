using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private const string BtwPrompt = """
        This is a side/background BTW request, not the main conversation turn.
        Answer only the BTW request below, using the copied conversation context only as background.
        Do not call tools in BTW mode. Tool execution is disabled for this request.
        If reliable completion would require a tool call or external side effect, say that it cannot be completed in BTW mode and explain briefly.
        """;

    internal async Task RunBtwAsync(SessionOwner source, string question)
    {
        // Join the existing accepted-operation lifetime, not foreground processing or Stop.
        using var lifetime = TrackCreation();
        SessionSnapshot snapshot;
        string cacheKey;
        using (BeginOwnerMutation(source))
        {
            cacheKey = await source.Entry.SaveLane.EnsurePromptCacheKeyAsync();
            snapshot = source.Entry.Snapshot();
        }
        string payload;
        string? modelId = null;
        string? virtualModel = null;
        ChatResult? result = null;
        try
        {
            var definitions = ModelDefinitions(source, selectedNode: ResolveExecutionNode(snapshot.AuthorityEnvelope, BoundNode(source.Agent)));
            var environment = ExecutionEnvironment(source, snapshot);
            var requestId = Guid.NewGuid().ToString();
            var catalog = models.Capture();
            var selected = catalog.Select(snapshot.AuthorityEnvelope);
            var request = new ModelRequestOwner(http, clientOptions, modelRouting,
                websockets: websockets, images: Images, journal: Journal);
            var history = RequestHistory.FromSnapshot(snapshot.History).WithContext([
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject { ["system"] = "<foxwarm-system kind=\"btw\" type=\"side-request\">\n" + BtwPrompt + "\n</foxwarm-system>" },
                        new JsonObject { ["text"] = question }),
                },
            ]);
            var persistent = SessionWait.Text(snapshot.AuthorityEnvelope["persistentMemorySnapshot"]) ?? "";
            string? attemptedModel = null;
            async Task<string> Prompt(ConcreteHostModel leaf, CancellationToken token)
            {
                attemptedModel = leaf.Key;
                if (ConditionalMemory.ReadCurrentModelSnapshotId(persistent) != leaf.Key)
                    persistent = await memory.BuildAsync(snapshot.AuthorityEnvelope["agent"]?.GetValue<string>() ?? source.Agent,
                        snapshot.Id, leaf.Key, token, AgentMemory.Selection(snapshot.AuthorityEnvelope));
                var value = persistent + "\n\n" + environment;
                return clientOptions.Instructions.Length == 0 ? value : clientOptions.Instructions + "\n\n" + value;
            }
            result = await request.RequestAsync(snapshot.Id,
                request.Capture(catalog, selected.RawModel ?? catalog.DefaultKey, selected.RawEffort),
                cacheKey, requestId, history, Prompt, null, null, null,
                source.Entry.RecordBestEffortFailure, admissionStop.Token, ModelRequestScope.Btw,
                () => (JsonArray)definitions.DeepClone(), journalPurpose: "btw");
            var message = result.AssistantMessage;
            modelId = SessionWait.Text(message?["__meta"]?["modelId"]);
            modelId ??= attemptedModel;
            virtualModel = SessionWait.Text(message?["__meta"]?["virtualModelKey"])
                ?? (selected.Model.IsVirtual ? selected.Model.Key : null);
            var parts = (message?["parts"] as JsonArray)?.OfType<JsonObject>().ToArray() ?? [];
            var calls = parts.Select(part => part["functionCall"]).OfType<JsonObject>().ToArray();
            if (calls.Length > 0)
            {
                var names = calls.Select(call => SessionWait.Text(call["name"]))
                    .Where(name => !string.IsNullOrEmpty(name)).Distinct().Select(name => "`" + name + "`").ToArray();
                payload = "⚠️ [BTW aborted]\nThe side request attempted to call tool(s): "
                    + (names.Length == 0 ? "unknown tool" : string.Join(", ", names))
                    + ".\nBTW mode does not execute tools. Please ask in the main chat if tool use is needed.";
            }
            else
            {
                payload = message is null ? "" : AssistantText(message).Trim();
                if (payload.Length == 0)
                    payload = "(BTW completed with no text output.)";
            }
        }
        catch (Exception error)
        {
            payload = "⚠️ [BTW error]\n" + error.Message;
        }
        finally
        {
            // A detached result is not a canonical assistant continuation (notably for WS reuse).
            result?.FinalizeHistory(null, source.Entry.RecordBestEffortFailure);
        }
        var text = "📝 [BTW result]\n" + (payload.Trim().Length == 0 ? "(empty)" : payload.Trim());
        // Resolve the existing identity after the request; moves can retain aliases, deletion cannot recreate it.
        var target = await RequiredAsync(snapshot.Id);
        using var append = BeginOwnerMutation(target);
        var meta = new JsonObject { ["noticeType"] = "btw" };
        if (modelId is not null)
            meta["modelId"] = modelId;
        if (virtualModel is not null)
            meta["virtualModelKey"] = virtualModel;
        var display = new JsonObject
        {
            ["role"] = "model",
            ["modelVisible"] = false,
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = meta,
        };
        // Persistence is outside request retry: a local append failure never resends the generation.
        await target.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(state, [display], [], false, false,
                () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
        target.Entry.InvokeCommitted(target.Entry.Snapshot());
        BroadcastTransientText(target, text);
    }

    private static async Task ObserveBtwAsync(Task request, SessionOwner owner)
    {
        try { await request; }
        catch (Exception error) { owner.Entry.RecordBackgroundProcessorFailure(error); }
    }

    internal void StartBtw(SessionOwner owner, string question) =>
        _ = ObserveBtwAsync(RunBtwAsync(owner, question), owner);
}
