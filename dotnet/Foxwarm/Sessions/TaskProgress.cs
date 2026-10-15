using System.Text.Json;

namespace Foxwarm.Sessions;

internal static class TaskProgress
{
    internal static long[] Sequences(SessionSnapshot snapshot) => Sequences(snapshot.History);

    internal static long[] Sequences(IEnumerable<HistoryMessage> history) =>
        history
            .Where(IsOrdinaryVisible)
            .Select(row => row.Sequence ?? 0)
            .Where(seq => seq > 0)
            .Distinct()
            .OrderBy(seq => seq)
            .TakeLast(30)
            .ToArray();

    internal static bool IsOrdinaryVisible(HistoryMessage row)
    {
        var json = row.Data;
        if (
            json.TryGetProperty("__meta", out var meta)
            && meta.ValueKind == JsonValueKind.Object
            && (Truthy(meta, "goalReminder") || Truthy(meta, "contextBlock"))
        )
            return false;
        // Preserve canonical validation without creating a mutable copy.
        if (!CanonicalMessage.IsVisible(row))
            return false;
        return json.TryGetProperty("parts", out var parts)
            && parts
                .EnumerateArray()
                .Any(part =>
                    part.ValueKind == JsonValueKind.Object
                    && (
                        IsText(part, "text")
                        || Present(part, "functionCall")
                        || Present(part, "functionResponse")
                        || Present(part, "inlineData")
                        || Present(part, "inlineDataRef")
                    )
                );
    }

    private static bool IsText(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String;

    private static bool Present(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var value) && value.ValueKind != JsonValueKind.Null;

    private static bool Truthy(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var value)
        && value.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.False => false,
            JsonValueKind.Number => value.GetDouble() != 0,
            JsonValueKind.String => value.GetString()!.Length > 0,
            _ => true,
        };
}
