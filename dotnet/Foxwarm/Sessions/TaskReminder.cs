using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// The persisted fixed-interval reminder for a Session's own active Tasks. It is ordinary
/// system history for the model and compaction; progress counting and turn continuation
/// classification identify it by its metadata flag.
/// </summary>
internal static class TaskReminder
{
    internal const string MetaKey = "taskReminder";
    private const string Opening = "<foxwarm-system kind=\"task-reminder\"";
    private const string Closing = "</foxwarm-system>";

    /// <summary>Builds the history row for a consumed TaskStore context, or null when no Task is due.</summary>
    internal static JsonObject? Build(JsonObject context)
    {
        var current = context["tasks"]!.AsArray();
        if (current.Count == 0)
            return null;
        var lines = current.Select(item =>
            $"{item!["id"]!.GetValue<string>()} — {item["title"]!.GetValue<string>()} ({item["status"]!.GetValue<string>()})"
        );
        var omitted = context["omitted"]?.GetValue<int>() ?? 0;
        var omittedText = omitted > 0 ? $"\n{omitted} more tasks." : "";
        return new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject
                {
                    ["system"] =
                        Opening
                        + ">Continue the active tasks:\n"
                        + string.Join('\n', lines)
                        + omittedText
                        + Closing,
                }
            ),
            ["__meta"] = new JsonObject { [MetaKey] = true },
        };
    }

    /// <summary>
    /// Recognizes only the generated row: a flagged user message whose single part is the
    /// task-reminder wrapper. Authored text or additional content is ordinary input.
    /// </summary>
    internal static bool IsRow(JsonElement message)
    {
        if (
            message.ValueKind != JsonValueKind.Object
            || !message.TryGetProperty("role", out var role)
            || role.ValueKind != JsonValueKind.String
            || role.GetString() != "user"
            || !message.TryGetProperty("__meta", out var meta)
            || meta.ValueKind != JsonValueKind.Object
            || !meta.TryGetProperty(MetaKey, out var flag)
            || flag.ValueKind != JsonValueKind.True
            || !message.TryGetProperty("parts", out var parts)
            || parts.ValueKind != JsonValueKind.Array
            || parts.GetArrayLength() != 1
        )
            return false;
        var part = parts[0];
        if (
            part.ValueKind != JsonValueKind.Object
            || part.EnumerateObject().Count() != 1
            || !part.TryGetProperty("system", out var system)
            || system.ValueKind != JsonValueKind.String
        )
            return false;
        var text = system.GetString()!;
        // Canonical append stamps seq into the opening tag of persisted input wrappers.
        return text.StartsWith(Opening, StringComparison.Ordinal)
            && text.Length > Opening.Length
            && text[Opening.Length] is '>' or ' '
            && text.EndsWith(Closing, StringComparison.Ordinal);
    }
}
