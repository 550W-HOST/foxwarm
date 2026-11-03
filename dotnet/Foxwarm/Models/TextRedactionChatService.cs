using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed class TextRedactionChatService(
    HttpClient http,
    ResponsesClientOptions options,
    TextRedactionOptions settings,
    Action<string, ResponsesStreamProgress>? progress,
    Func<ResponsesClientOptions, Action<string, ResponsesStreamProgress>?, IChatService> create
) : IChatService
{
    public async Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken cancellationToken
    )
    {
        using var deadline = options.HardTimeoutMs is > 0
            ? new CancellationTokenSource(
                TimeSpan.FromMilliseconds(options.HardTimeoutMs.Value),
                options.Clock ?? TimeProvider.System
            )
            : null;
        using var lifetime = deadline is null
            ? null
            : CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
        var token = lifetime?.Token ?? cancellationToken;
        var redactor = TextRedactor.Shared;
        Task<string> Redact(string text) => redactor.RedactAsync(http, settings, text, token);
        string instructions;
        JsonArray? tools;
        try
        {
            await TextRedactionProjection.RedactHistoryAsync(history, Redact).ConfigureAwait(false);
            instructions = await Redact(options.Instructions).ConfigureAwait(false);
            tools = await TextRedactionProjection
                .ToolsAsync(options.Tools, Redact)
                .ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested
                && deadline?.IsCancellationRequested == true
            )
        {
            throw new TextRedactionException(
                "Text detection timed out; no model request was sent.",
                true
            );
        }
        var committed = new List<JsonObject>();
        var preparedOptions = options with
        {
            TextRedaction = null,
            HardTimeoutMs = null,
            Instructions = instructions,
            Tools = tools,
            CommitAssistantSegment = options.CommitAssistantSegment is null
                ? null
                : async (message, deliver) =>
                {
                    var restored = TextRedactionProjection.RestoreMessage(message, redactor);
                    var row = await options
                        .CommitAssistantSegment(restored, deliver)
                        .ConfigureAwait(false);
                    committed.Add(row);
                    // The transport's append/replay state keeps the provider representation.
                    var wireRow = (JsonObject)row.DeepClone();
                    wireRow["parts"] = message["parts"]?.DeepClone();
                    return wireRow;
                },
        };
        var service = create(
            preparedOptions,
            progress is null
                ? null
                : (id, value) =>
                    progress(id, TextRedactionProjection.RestoreProgress(value, redactor))
        );
        var result = await service.ChatAsync(sessionId, history, token).ConfigureAwait(false);
        var wireAssistant = result.AssistantMessage is null
            ? null
            : (JsonObject)result.AssistantMessage.DeepClone();
        // Canonical replay serializes the transformed argument object, including
        // on the next turn. Use that same representation for the WS prefix.
        foreach (var part in (wireAssistant?["parts"] as JsonArray ?? []).OfType<JsonObject>())
            if (
                part["functionCall"] is JsonObject call
                && call["args"] is JsonObject args
                && call.ContainsKey("rawArgsText")
                && string.IsNullOrEmpty(SessionWait.Text(call["argsParseError"]))
            )
                call["rawArgsText"] = args.ToJsonString();
        var restoredAssistant = wireAssistant is null
            ? null
            : TextRedactionProjection.RestoreMessage(wireAssistant, redactor);
        var finalizer = result.HistoryAppend;
        return result with
        {
            AssistantMessage = restoredAssistant,
            CommittedSegments = committed,
            HistoryAppend = finalizer is null
                ? null
                : new HistoryAppendFinalizer(rows =>
                {
                    if (rows is null || wireAssistant is null || restoredAssistant is null)
                    {
                        finalizer.Settle(null, null);
                        return;
                    }
                    // Canonical append may add metadata/repair rows. Substitute only the
                    // assistant that was actually returned, never rescan or guess replay text.
                    var found = false;
                    var replay = rows.Select(row =>
                        {
                            var copy = (JsonObject)row.DeepClone();
                            if (
                                SessionWait.Text(row["role"]) == "model"
                                && JsonNode.DeepEquals(row["parts"], restoredAssistant["parts"])
                            )
                            {
                                copy["parts"] = wireAssistant["parts"]?.DeepClone();
                                found = true;
                            }
                            return copy;
                        })
                        .ToArray();
                    finalizer.Settle(found ? replay : null, null);
                }),
        };
    }
}
