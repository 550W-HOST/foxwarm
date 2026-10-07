using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal static class TaskProgress
{
    internal static bool IsOrdinaryVisible(JsonObject row)
    {
        var meta = row["__meta"] as JsonObject;
        if (Truthy(meta?["goalReminder"]) || Truthy(meta?["contextBlock"]))
            return false;
        if (!CanonicalMessage.FromNode(row).IsModelVisible)
            return false;
        return row["parts"] is JsonArray parts
            && parts.Any(part =>
                part is JsonObject value
                && (
                    IsText(value["text"])
                    || value["functionCall"] is not null
                    || value["functionResponse"] is not null
                    || value["inlineData"] is not null
                    || value["inlineDataRef"] is not null
                )
            );
    }

    internal static long[] Sequences(SessionSnapshot snapshot) =>
        snapshot
            .History.Where(IsOrdinaryVisible)
            .Select(row => row["__meta"]?["seq"])
            .OfType<JsonValue>()
            .Select(value => value.TryGetValue<long>(out var seq) ? seq : 0)
            .Where(seq => seq > 0)
            .Distinct()
            .OrderBy(seq => seq)
            .TakeLast(30)
            .ToArray();

    private static bool IsText(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out _);

    private static bool Truthy(JsonNode? node) =>
        node switch
        {
            null => false,
            JsonValue value when value.TryGetValue<bool>(out var boolean) => boolean,
            JsonValue value when value.TryGetValue<double>(out var number) => number != 0,
            JsonValue value when value.TryGetValue<string>(out var text) => text.Length > 0,
            _ => true,
        };
}
