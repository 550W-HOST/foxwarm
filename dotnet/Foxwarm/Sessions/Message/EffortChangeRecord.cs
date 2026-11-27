using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

/// <summary>
/// A persisted, display-free history row recording that the effort of one concrete model
/// changed at this position. Adapters with per-message effort replay it in place; every other
/// consumer ignores it as a non-context row.
/// </summary>
internal sealed record EffortChangeRecord(string ModelId, string PreviousEffort, string Effort)
{
    internal const string PartKey = "effortChange";

    internal JsonObject ToRow() =>
        new()
        {
            ["role"] = "user",
            ["modelVisible"] = false,
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    [PartKey] = new JsonObject
                    {
                        ["modelId"] = ModelId,
                        ["previousEffort"] = PreviousEffort,
                        ["effort"] = Effort,
                    },
                }
            ),
        };

    internal static EffortChangeRecord? Read(JsonObject row)
    {
        if (
            SessionWait.Text(row["role"]) != "user"
            || row["modelVisible"] is not JsonValue flag
            || !flag.TryGetValue<bool>(out var visible)
            || visible
            || row["parts"] is not JsonArray { Count: 1 } parts
            || parts[0] is not JsonObject { Count: 1 } part
            || part[PartKey] is not JsonObject change
        )
            return null;
        return Create(
            SessionWait.Text(change["modelId"]),
            SessionWait.Text(change["previousEffort"]),
            SessionWait.Text(change["effort"])
        );
    }

    internal static EffortChangeRecord? Read(HistoryMessage message)
    {
        var row = message.Data;
        if (
            message.Role != "user"
            || !row.TryGetProperty("modelVisible", out var visible)
            || visible.ValueKind != JsonValueKind.False
            || !row.TryGetProperty("parts", out var parts)
            || parts.ValueKind != JsonValueKind.Array
            || parts.GetArrayLength() != 1
        )
            return null;
        var part = parts[0];
        if (
            part.ValueKind != JsonValueKind.Object
            || part.EnumerateObject().Count() != 1
            || !part.TryGetProperty(PartKey, out var change)
        )
            return null;
        return Create(
            HistoryMessage.Text(change, "modelId"),
            HistoryMessage.Text(change, "previousEffort"),
            HistoryMessage.Text(change, "effort")
        );
    }

    internal static bool Is(JsonObject row) => Read(row) is not null;

    // `none` disables thinking, which is a top-level request change, so it is never recorded.
    private static EffortChangeRecord? Create(string? model, string? previous, string? effort) =>
        string.IsNullOrEmpty(model)
        || previous is null
        || effort is null
        || previous == effort
        || !Recordable(previous)
        || !Recordable(effort)
            ? null
            : new(model, previous, effort);

    internal static bool Recordable(string? effort) =>
        effort is not null and not "none" && HostModels.Efforts.Contains(effort);
}
