using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed record PreviewItem(string Heading, string Body, string Search, string? OmittedTools);
internal sealed partial class ContextPreviewRenderer
{
    private static string Text(JsonNode? node) => SessionWait.Text(node) ?? "";
    private static string Unknown(JsonNode? node) => node is null ? "" : SessionWait.Text(node) ?? EcmaJson.Stringify(node);
    private static string Id(JsonNode? node) => Text(node).Length == 0 ? "" : "(" + Text(node) + ")";
    private static string Args(JsonObject call) => SessionWait.Text(call["rawArgsText"]) ?? (call["args"] is null ? "{}" : EcmaJson.Stringify(call["args"]!));
    private static string Response(JsonObject response)
    {
        response = (JsonObject)Foxwarm.Images.ImageTransport.Project(response)!;
        if (response["response"] is not JsonObject value) return Unknown(response["response"]);
        if (value["error"] is not null) return "ERROR: " + Unknown(value["error"]);
        if (value["output"] is not null) return Unknown(value["output"]);
        if (value["content"] is not null) return Unknown(value["content"]);
        if (value["inlineData"] is not null || value["inlineDataItems"] is not null) return "[inline data]";
        return Unknown(value);
    }
    private static string? SystemText(string text)
    {
        var channel = Regex.Match(text, "^<foxwarm-message\\b[^>]*type=[\\\"']channel[\\\"'][^>]*>\\s*([\\s\\S]*?)\\s*</foxwarm-message>\\s*$");
        if (channel.Success) return SessionGoal.Trim(channel.Groups[1].Value);
        if (Regex.IsMatch(text, "^</foxwarm-(?:system|message)>\\s*$")
            || Regex.IsMatch(text, "^<foxwarm-system\\b[^>]*kind=[\\\"'](?:time|session|channel-mode)[\\\"']")
            || text.StartsWith("current time =", StringComparison.Ordinal) || text.StartsWith("current session ID =", StringComparison.Ordinal)
            || text.StartsWith("FROM:", StringComparison.Ordinal) || text.StartsWith("The following message is a direct user message via channel;", StringComparison.Ordinal)
            || text.StartsWith("Channel is in push-only mode.", StringComparison.Ordinal) || text.StartsWith("Channel is in send-only mode.", StringComparison.Ordinal)) return null;
        return "[system] " + text;
    }
    private PreviewItem Item(JsonObject message, double offset)
    {
        var body = new List<string>(); var search = new List<string>(); var tool = new List<string>();
        var calls = new List<string>(); var responses = new List<string>();
        foreach (var part in (message["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            if (SessionWait.Text(part["system"]) is string system && SystemText(system) is string visible && visible.Length > 0) { body.Add(visible); search.Add(visible); }
            if (SessionWait.Text(part["text"]) is string text && SessionGoal.Trim(text).Length > 0 && !text.Contains("--- RELEVANT MEMORY SNIPPETS (RAG) ---", StringComparison.Ordinal))
            { body.Add(SessionGoal.Trim(text)); search.Add(SessionGoal.Trim(text)); }
            if (SessionWait.Text(part["thinking"]) is string thinking && SessionGoal.Trim(thinking).Length > 0) search.Add("[thinking] " + thinking);
            var image = part["inlineDataRef"] as JsonObject ?? part["inlineData"] as JsonObject;
            if (image is not null)
            {
                var line = "[image:" + (SessionWait.Text(image["mimeType"]) ?? SessionWait.Text(image["mime_type"]) ?? "application/octet-stream") + "]";
                var imageId = SessionWait.Text(image["imageId"]) ?? SessionWait.Text((part["imageMeta"] as JsonObject)?["imageId"]);
                if (imageId is not null) line += " " + imageId;
                body.Add(line); search.Add(line);
            }
            if (part["functionCall"] is JsonObject call)
            {
                var label = Text(call["name"]) + Id(call["id"]); var args = Args(call); var line = $"[call:{label}] {args}";
                tool.Add(line); search.Add(line); calls.Add(label);
                if (detail != "names") body.Add(detail == "full" ? line : $"[call:{label}] " + Snippet(args, Active ? 360 : 240));
            }
            if (part["functionResponse"] is JsonObject response)
            {
                var name = SessionWait.Text(response["name"]) ?? "unknown"; var label = name + Id(response["tool_use_id"]);
                var content = Response(response); var line = $"[tool:{label}] {content}";
                tool.Add(line); search.Add(line);
                responses.Add(label + ": " + ((response["response"] as JsonObject)?["error"] is null ? "ok" : "error") + " (content omitted)");
                if (detail != "names") body.Add(detail == "full" ? line : $"[tool:{label}] " + Snippet(content, Active ? 420 : 260));
            }
        }
        if (detail == "names")
        {
            if (calls.Count > 0) body.Add("Tool calls: " + string.Join(", ", calls));
            if (responses.Count > 0) body.Add("Tool results: " + string.Join(", ", responses));
        }
        var role = Text(message["role"]); var emoji = role == "user" ? "👤" : role == "model" ? "🤖" : "🔧";
        var visibility = message["modelVisible"] is JsonValue flag && flag.TryGetValue<bool>(out var value) && !value ? " [non-context]" : "";
        return new($"[{EcmaNumber.Format(offset)}] {emoji} {role}{visibility}:", body.Count == 0 ? "[empty message]" : string.Join('\n', body), string.Join('\n', search), detail == "names" ? string.Join('\n', tool) : null);
    }
}
