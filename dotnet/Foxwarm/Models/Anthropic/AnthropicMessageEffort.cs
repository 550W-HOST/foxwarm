using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

/// <summary>
/// Anthropic per-message effort: an effort change is persisted once as an
/// <see cref="EffortChangeRecord"/> and replayed as an effort-only <c>role: system</c> message,
/// so the top-level effort and the prefix before the change stay byte-identical.
/// </summary>
internal static class AnthropicMessageEffort
{
    internal const string Beta = "mid-conversation-output-config-2026-07-01";
    internal const string Option = "perMessageEffort";
    private const string BetaHeader = "anthropic-beta";

    internal static bool Configured(ConcreteHostModel leaf) =>
        leaf.ProviderType == "anthropic"
        && leaf.Configuration[Option] is JsonValue flag
        && flag.TryGetValue<bool>(out var enabled)
        && enabled;

    // The API rejects a per-message effort at a new level in these thinking modes.
    internal static bool FixedThinking(JsonObject? extraFields) =>
        SessionWait.Text((extraFields?["thinking"] as JsonObject)?["type"])
            is "disabled"
                or "between_tools";

    /// <summary>Whether normal requests of this leaf record effort changes as history rows.</summary>
    internal static bool Records(ConcreteHostModel leaf) =>
        Configured(leaf) && !FixedThinking(leaf.Configuration["extraFields"] as JsonObject);

    /// <summary>Whether this request replays recorded changes instead of a moving top level.</summary>
    internal static bool Applies(ResponsesClientOptions options) =>
        options.PerMessageEffort
        && options.ConcreteModelId is not null
        && EffortChangeRecord.Recordable(options.Effort)
        && !FixedThinking(options.ExtraFields);

    /// <summary>
    /// The row to append before a normal request whose adopted effort differs from the effort
    /// in force for that model. The effort in force is the model's latest recorded change in
    /// active history, otherwise the previous adopted request of the same model. An unknown
    /// baseline (first request, fork, compaction without records after a model switch) records
    /// nothing, so the request keeps today's top-level effort.
    /// </summary>
    internal static EffortChangeRecord? Change(
        IReadOnlyList<HistoryMessage> history,
        EffectiveRequestSelection selection,
        EffectiveRequestSelection? previous
    )
    {
        var inForce =
            InForce(history, selection.ModelId)
            ?? (previous?.ModelId == selection.ModelId ? previous.Effort : null);
        return
            inForce is null
            || inForce == selection.Effort
            || !EffortChangeRecord.Recordable(inForce)
            || !EffortChangeRecord.Recordable(selection.Effort)
            ? null
            : new EffortChangeRecord(selection.ModelId, inForce, selection.Effort);
    }

    internal static string? InForce(IReadOnlyList<HistoryMessage> history, string modelId)
    {
        for (var index = history.Count - 1; index >= 0; index--)
            if (EffortChangeRecord.Read(history[index]) is { } change && change.ModelId == modelId)
                return change.Effort;
        return null;
    }

    /// <summary>The top-level effort: the one in force before the model's first recorded change.</summary>
    internal static string? BaseEffort(IEnumerable<JsonObject> history, string modelId)
    {
        foreach (var row in history)
            if (EffortChangeRecord.Read(row) is { } change && change.ModelId == modelId)
                return change.PreviousEffort;
        return null;
    }

    internal static JsonObject Message(EffortChangeRecord change) =>
        new()
        {
            ["role"] = "system",
            ["content"] = new JsonArray(),
            ["output_config"] = new JsonObject { ["effort"] = change.Effort },
        };

    internal static bool Uses(JsonObject body) =>
        (body["messages"] as JsonArray)
            ?.OfType<JsonObject>()
            .Any(message =>
                SessionWait.Text(message["role"]) == "system" && message["output_config"] is not null
            ) == true;

    /// <summary>
    /// Adds the beta to the header list a request would otherwise send: a configured
    /// <c>anthropic-beta</c> header replaces the adapter default as before, and the required
    /// beta is merged into that list rather than replacing it. Returns request options without
    /// the configured header so it cannot overwrite the merged value.
    /// </summary>
    internal static ResponsesClientOptions MergeBetaHeader(
        IDictionary<string, string> headers,
        ResponsesClientOptions options
    )
    {
        var current = headers.TryGetValue(BetaHeader, out var value) ? value : null;
        JsonObject? remaining = null;
        if (options.ExtraHeaders is { } configured)
        {
            remaining = new JsonObject();
            foreach (var (name, header) in configured)
                if (string.Equals(name, BetaHeader, StringComparison.OrdinalIgnoreCase))
                    current = header?.ToString() ?? "";
                else
                    remaining[name] = header?.DeepClone();
        }
        headers[BetaHeader] = string.Join(
            ",",
            (current ?? "")
                .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Append(Beta)
                .Distinct(StringComparer.Ordinal)
        );
        return remaining is null ? options : options with { ExtraHeaders = remaining };
    }
}
