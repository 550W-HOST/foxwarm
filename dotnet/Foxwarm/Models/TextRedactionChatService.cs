using System.Diagnostics;
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
        TextRedactor redactor;
        try
        {
            redactor =
                options.TextRedactorSource?.Invoke()
                ?? throw new InvalidOperationException("No instance key source.");
        }
        catch (Exception)
        {
            // Without the instance key no placeholder can be formed; never send the original.
            throw new TextRedactionException(
                "Text redaction is unavailable because the instance key cannot be read; no model request was sent. Check Setup > Secrets.",
                false,
                kind: TextRedactionFailureKind.Config
            );
        }
        var stats = options.TextRedactionStats;
        var scope = new TextRedactionScope(redactor, http, settings, token)
        {
            OmitOversized = options.TextRedactionOmitsOversized,
            Stats = stats,
        };
        var started = Stopwatch.GetTimestamp();
        Task<string> Detect(string text) => scope.DetectAsync(text);
        Task<string> MaskKnown(string text) => Task.FromResult(scope.MaskKnown(text));
        string instructions;
        JsonArray? tools;
        try
        {
            // With combined calls or a concurrency limit above one, detect the slot texts ahead.
            // The collecting pass runs on a throwaway copy because the projection rewrites slots.
            if (settings.MaxConcurrency > 1 || settings.BatchBytes > 0)
            {
                var texts = new List<string>();
                Task<string> Collect(string text)
                {
                    texts.Add(text);
                    return Task.FromResult(text);
                }
                await TextRedactionProjection
                    .RedactHistoryAsync(
                        history.Select(message => (JsonObject)message.DeepClone()).ToArray(),
                        Collect
                    )
                    .ConfigureAwait(false);
                texts.Add(options.Instructions);
                await TextRedactionProjection
                    .ToolsAsync(options.Tools, Collect)
                    .ConfigureAwait(false);
                await scope.PrefetchAsync(texts).ConfigureAwait(false);
            }
            // Detect every slot in order, then mask known originals everywhere, including
            // ones this request just found.
            await TextRedactionProjection.RedactHistoryAsync(history, Detect).ConfigureAwait(false);
            instructions = await Detect(options.Instructions).ConfigureAwait(false);
            tools = await TextRedactionProjection
                .ToolsAsync(options.Tools, Detect)
                .ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            await TextRedactionProjection
                .RedactHistoryAsync(history, MaskKnown)
                .ConfigureAwait(false);
            instructions = scope.MaskKnown(instructions);
            tools = await TextRedactionProjection
                .ToolsAsync(tools, MaskKnown)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
            when (!cancellationToken.IsCancellationRequested
                && deadline?.IsCancellationRequested == true
            )
        {
            throw new TextRedactionException(
                "Text detection timed out; no model request was sent.",
                true,
                kind: TextRedactionFailureKind.Timeout
            );
        }
        finally
        {
            if (stats is not null)
                stats.DetectionMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        }
        if (stats is not null)
            stats.Completed = true;
        var committed = new List<JsonObject>();
        var preparedOptions = options with
        {
            TextRedaction = null,
            TextRedactionStats = null,
            Instructions = instructions,
            Tools = tools,
            CommitAssistantSegment = options.CommitAssistantSegment is null
                ? null
                : async (message, deliver) =>
                {
                    var restored = TextRedactionProjection.RestoreMessage(message, scope);
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
                : (id, value) => progress(id, TextRedactionProjection.RestoreProgress(value, scope))
        );
        var result = await service.ChatAsync(sessionId, history, token).ConfigureAwait(false);
        var wireAssistant = result.AssistantMessage is null
            ? null
            : (JsonObject)result.AssistantMessage.DeepClone();
        // A restored call is re-serialized canonically, and the next request serializes its
        // redacted arguments the same way. Use that representation for the WS prefix; a
        // call without placeholders keeps the provider's raw text on both sides.
        foreach (var part in (wireAssistant?["parts"] as JsonArray ?? []).OfType<JsonObject>())
            if (
                part["functionCall"] is JsonObject call
                && call["args"] is JsonObject args
                && call.ContainsKey("rawArgsText")
                && string.IsNullOrEmpty(SessionWait.Text(call["argsParseError"]))
                && TextRedactionProjection.Restores(call, scope)
            )
                call["rawArgsText"] = TextRedactionProjection.Serialize(args);
        var restoredAssistant = wireAssistant is null
            ? null
            : TextRedactionProjection.RestoreMessage(wireAssistant, scope);
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
