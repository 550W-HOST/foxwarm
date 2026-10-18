using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Vector;

internal static class VectorText
{
    internal const string QueryPrefix =
        "Instruct: Retrieve relevant historical conversation context for the query.\nQuery: ";

    internal static string Text(JsonNode? value) => SessionWait.Text(value) ?? "";

    internal static string Trim(string text) => SessionGoal.Trim(text);

    internal static int Tokens(string text) => CompactCandidateBuilder.Tokens(text);

    internal static string Truncate(string text, int tokens = 1500)
    {
        if (Tokens(text) <= tokens)
            return text;
        var left = 0;
        var right = text.Length;
        while (left < right)
        {
            var mid = (left + right + 1) / 2;
            if (Tokens(text[..mid]) <= tokens)
                left = mid;
            else
                right = mid - 1;
        }
        return text[..left];
    }

    internal static string WellFormed(string text)
    {
        var output = new StringBuilder(text.Length);
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (
                char.IsHighSurrogate(character)
                && index + 1 < text.Length
                && char.IsLowSurrogate(text[index + 1])
            )
            {
                output.Append(character).Append(text[++index]);
            }
            else
                output.Append(char.IsSurrogate(character) ? '\ufffd' : character);
        }
        return output.ToString();
    }

    internal static string Lower(string text) => SourceStringLower.Lower(text);

    internal static string Normalize(string text) =>
        Lower(WellFormed(text).Normalize(NormalizationForm.FormKC));

    internal static string Hash(string text) =>
        Convert.ToHexStringLower(
            System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(WellFormed(text)))
        );

    internal static string SafeClip(string text, int chars) =>
        text.Length <= chars
            ? text
            : text[
                ..(
                    chars > 0
                    && char.IsHighSurrogate(text[chars - 1])
                    && char.IsLowSurrogate(text[chars])
                        ? chars - 1
                        : chars
                )
            ];

    private static string ToolClip(string text, int limit)
    {
        if (limit <= 0 || text.Length <= limit)
            return text;
        return CompactPrompt.TruncateGraphemes(WellFormed(text), limit, "...", false);
    }

    private static bool Truthy(JsonNode? node) =>
        node is not null
        && !(
            node is JsonValue value
            && (
                value.TryGetValue<bool>(out var flag) && !flag
                || value.TryGetValue<string>(out var text) && text.Length == 0
                || SessionWait.Number(node) is 0
            )
        );

    private static string Args(JsonObject call)
    {
        if (Truthy(call["argsParseError"]))
        {
            var error = new JsonObject { ["error"] = call["argsParseError"]!.DeepClone() };
            if (Truthy(call["rawArgsText"]))
                error["rawArgsText"] = call["rawArgsText"]!.DeepClone();
            return EcmaJson.Stringify(error);
        }
        return SessionWait.Text(call["rawArgsText"])
            ?? (Truthy(call["args"]) ? EcmaJson.Stringify(call["args"]!) : "{}");
    }

    private static string JsonText(JsonNode? node) =>
        node is null ? "" : SessionWait.Text(node) ?? EcmaJson.Stringify(node);

    private static readonly string[] EphemeralPrefixes =
    [
        "current time =",
        "current session ID =",
        "FROM:",
        "The following message is a direct user message via channel;",
        "Channel is in push-only mode.",
        "Channel is in send-only mode.",
    ];

    private static string? SystemText(string text, out bool channel)
    {
        channel = false;
        var wrapped = Regex.Match(
            text,
            @"^\s*<foxwarm-message\b(?<attrs>[^>]*)>\s*\n?(?<body>[\s\S]*)\n?\s*</foxwarm-message\s*>\s*$",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
        );
        if (wrapped.Success && Attribute(wrapped.Groups["attrs"].Value, "type") == "channel")
        {
            channel = true;
            return Multiline(wrapped.Groups["body"].Value);
        }
        var opening = Regex.Match(
            text,
            @"^\s*<(?<tag>foxwarm-(?:system|message))\b(?<attrs>[^>]*)>\s*",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase
        );
        if (
            Regex.IsMatch(text, @"^\s*</foxwarm-message\s*>\s*$", RegexOptions.IgnoreCase)
            || opening.Success
                && (
                    opening
                        .Groups["tag"]
                        .Value.Equals("foxwarm-system", StringComparison.OrdinalIgnoreCase)
                        && Attribute(opening.Groups["attrs"].Value, "kind")
                            is "time"
                                or "session"
                                or "channel-mode"
                    || opening
                        .Groups["tag"]
                        .Value.Equals("foxwarm-message", StringComparison.OrdinalIgnoreCase)
                        && Attribute(opening.Groups["attrs"].Value, "type") == "channel"
                )
            || EphemeralPrefixes.Any(prefix => text.StartsWith(prefix, StringComparison.Ordinal))
        )
            return null;
        return "[system] " + text;
    }

    private static string? Attribute(string text, string name)
    {
        var match = Regex.Match(text, "(?:^|\\s)" + name + "\\s*=\\s*\"([^\"]*)\"");
        return match.Success
            ? match
                .Groups[1]
                .Value.Replace("&quot;", "\"", StringComparison.Ordinal)
                .Replace("&apos;", "'", StringComparison.Ordinal)
                .Replace("&lt;", "<", StringComparison.Ordinal)
                .Replace("&gt;", ">", StringComparison.Ordinal)
                .Replace("&amp;", "&", StringComparison.Ordinal)
            : null;
    }

    private static string Multiline(string text) => string.Join("\n> ", Trim(text).Split('\n'));

    internal static string Message(
        JsonObject message,
        bool rolePrefix = true,
        bool substantive = false,
        int toolLimit = 200,
        bool visibleOnly = true
    )
    {
        if (
            (visibleOnly || substantive)
            && message["modelVisible"] is JsonValue flag
            && flag.TryGetValue<bool>(out var visible)
            && !visible
        )
            return "";
        var role = Text(message["role"]);
        if (substantive && role is not ("user" or "model"))
            return "";
        var lines = new List<string>();
        foreach (var part in (message["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            if (part["system"] is JsonValue)
            {
                var system = SystemText(Text(part["system"]), out var channel);
                if (system is not null)
                    lines.Add(system);
                if (channel)
                    continue;
            }
            var text = Text(part["text"]);
            if (
                Trim(text).Length > 0
                && !text.Contains(
                    "--- RELEVANT MEMORY SNIPPETS (RAG) ---",
                    StringComparison.Ordinal
                )
            )
                lines.Add(role is "user" or "model" ? text : ToolClip(text, toolLimit));
            if (substantive)
                continue;
            if (part["functionCall"] is JsonObject call)
                lines.Add("[call:" + Text(call["name"]) + "] " + ToolClip(Args(call), toolLimit));
            if (
                part["functionResponse"] is JsonObject response
                && response["response"] is JsonNode value
                && Truthy(value)
            )
            {
                var body = value is JsonObject obj
                    ? Truthy(obj["error"])
                        ? "ERROR: " + JsonText(obj["error"])
                        : obj["output"] is { } output
                            ? JsonText(output)
                            : obj["content"] is { } content
                                ? JsonText(content)
                                : Truthy(obj["inlineData"]) || Truthy(obj["inlineDataItems"])
                                    ? "[inline data]"
                                    : JsonText(obj)
                    : JsonText(value);
                if (body.Length > 0)
                    lines.Add(
                        "[tool:"
                            + (SessionWait.Text(response["name"]) ?? "unknown")
                            + "] "
                            + ToolClip(body, toolLimit)
                    );
            }
            var image = part["inlineDataRef"] as JsonObject ?? part["inlineData"] as JsonObject;
            if (image is not null)
            {
                var mime =
                    SessionWait.Text(image["mimeType"])
                    ?? SessionWait.Text(image["mime_type"])
                    ?? "application/octet-stream";
                var id = part["inlineDataRef"] is not null
                    ? SessionWait.Text(image["imageId"]) ?? "image"
                    : SessionWait.Text((part["imageMeta"] as JsonObject)?["imageId"]);
                lines.Add("[image:" + mime + "]" + (id is null ? "" : " " + id));
            }
        }
        var bodyText = Trim(string.Join('\n', lines.Where(line => line.Length > 0)));
        if (bodyText.Length == 0)
            return "";
        return (rolePrefix ? "[" + role + "] " : "") + Multiline(bodyText);
    }

    internal static IReadOnlyList<string> Chunks(string text)
    {
        text = Trim(text);
        if (text.Length == 0)
            return [];
        var result = new List<string>();
        var start = 0;
        while (start < text.Length)
        {
            var end = start + Truncate(text[start..]).Length;
            if (end < text.Length)
            {
                var boundaryStart = Math.Max(start, end - (int)Math.Floor((end - start) * .2));
                var newline = text.LastIndexOf('\n', Math.Min(end, text.Length - 1));
                if (newline >= boundaryStart)
                    end = newline + 1;
            }
            var chunk = Trim(text[start..end]);
            if (chunk.Length > 0)
                result.Add(chunk);
            start = end;
        }
        return result;
    }
}
