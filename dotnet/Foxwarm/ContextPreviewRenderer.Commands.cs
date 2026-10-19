using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed partial class ContextPreviewRenderer
{
    // Command previews use active offsets and a per-message limit, not the recall page budget.
    internal static string CommandMessages(
        string sessionId,
        int total,
        int start,
        IReadOnlyList<JsonObject> messages
    )
    {
        static string Short(string value)
        {
            if (value.Length <= 100)
                return value;
            var end = 97;
            if (char.IsHighSurrogate(value[end - 1]) && char.IsLowSurrogate(value[end]))
                end--;
            return value[..end] + "...";
        }
        var output = $"Session `{sessionId}` - showing {messages.Count} of {total} message(s):\n\n";
        string? previousDay = null;
        for (var index = 0; index < messages.Count; index++)
        {
            var message = messages[index];
            var lines = new List<string>();
            foreach (var part in (message["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
            {
                if (
                    SessionWait.Text(part["system"]) is { } system
                    && SystemText(system) is { } visible
                )
                    lines.Add(visible);
                if (SessionWait.Text(part["text"]) is { } text && !string.IsNullOrWhiteSpace(text))
                    lines.Add(text);
                if (part["functionCall"] is JsonObject call)
                    lines.Add($"[call:{call["name"]}] {Short(Args(call))}");
                if (part["functionResponse"] is JsonObject response)
                    lines.Add(
                        $"[tool:{SessionWait.Text(response["name"]) ?? "unknown"}] {Short(Response(response))}"
                    );
                var image = part["inlineDataRef"] as JsonObject ?? part["inlineData"] as JsonObject;
                if (image is not null)
                    lines.Add(
                        $"[image:{SessionWait.Text(image["mimeType"]) ?? SessionWait.Text(image["mime_type"]) ?? "application/octet-stream"}]"
                            + (
                                (
                                    SessionWait.Text(image["imageId"])
                                    ?? SessionWait.Text(part["imageMeta"]?["imageId"])
                                )
                                    is { } id
                                    ? " " + id
                                    : ""
                            )
                    );
            }
            var preview = string.Join("\n", lines).Trim();
            if (preview.Contains('\n'))
                preview = preview.Replace("\n", "\n> ");
            preview = Short(preview);
            var role = SessionWait.Text(message["role"]) ?? "";
            var emoji =
                role == "user" ? "👤"
                : role == "model" ? "🤖"
                : "🔧";
            var visibility =
                message["modelVisible"]?.GetValue<bool>() == false ? " [non-context]" : "";
            var time = "";
            if (
                SessionWait.Number(message["__meta"]?["timestamp"]) is { } stamp
                && stamp >= DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
                && stamp <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds()
            )
            {
                var date = DateTimeOffset.FromUnixTimeMilliseconds((long)stamp).LocalDateTime;
                var day = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                time =
                    " time "
                    + date.ToString(
                        day == previousDay ? "HH:mm:ss" : "yyyy-MM-dd HH:mm:ss",
                        CultureInfo.InvariantCulture
                    )
                    + " "
                    + new DateTimeOffset(date)
                        .ToString("zzz", CultureInfo.InvariantCulture)
                        .Replace(":", "");
                previousDay = day;
            }
            else
                previousDay = null;
            output += $"[{start + index}{time}] {emoji} {role}{visibility}: {preview}\n";
        }
        return output;
    }
}
