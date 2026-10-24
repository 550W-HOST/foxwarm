using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm;

internal sealed record PreviewTool(string Name, string? Id, bool Result, bool Error);

internal sealed record PreviewItem(
    string Heading,
    string Body,
    string Search,
    string? OmittedTools,
    IReadOnlyList<string>? PriorityNotices = null,
    IReadOnlyList<PreviewTool>? Tools = null,
    bool ToolOnly = false,
    long? SourceIndex = null,
    string? DrillDown = null,
    string? UnfoldedBody = null,
    string? ArchiveSession = null,
    long? Sequence = null,
    long? EndSequence = null
);

internal sealed partial class ContextPreviewRenderer
{
    private static string Text(JsonNode? node) => SessionWait.Text(node) ?? "";

    private static string Unknown(JsonNode? node) =>
        node is null ? "" : SessionWait.Text(node) ?? EcmaJson.Stringify(node);

    private static string Args(JsonObject call) =>
        SessionWait.Text(call["rawArgsText"])
        ?? (call["args"] is null ? "{}" : EcmaJson.Stringify(call["args"]!));

    private static string Response(JsonObject response)
    {
        response = (JsonObject)Foxwarm.Images.ImageTransport.Project(response)!;
        if (response["response"] is not JsonObject value)
            return Unknown(response["response"]);
        if (value["error"] is not null)
            return "ERROR: " + Unknown(value["error"]);
        if (value["output"] is not null)
            return Unknown(value["output"]);
        if (value["content"] is not null)
            return Unknown(value["content"]);
        if (value["inlineData"] is not null || value["inlineDataItems"] is not null)
            return "[inline data]";
        return Unknown(value);
    }

    private static string? SystemText(string text)
    {
        var channel = Regex.Match(
            text,
            "^<foxwarm-message\\b[^>]*type=[\\\"']channel[\\\"'][^>]*>\\s*([\\s\\S]*?)\\s*</foxwarm-message>\\s*$"
        );
        if (channel.Success)
            return SessionGoal.Trim(channel.Groups[1].Value);
        if (
            Regex.IsMatch(text, "^</foxwarm-(?:system|message)>\\s*$")
            || Regex.IsMatch(
                text,
                "^<foxwarm-system\\b[^>]*kind=[\\\"'](?:time|session|channel-mode)[\\\"']"
            )
            || text.StartsWith("current time =", StringComparison.Ordinal)
            || text.StartsWith("current session ID =", StringComparison.Ordinal)
            || text.StartsWith("FROM:", StringComparison.Ordinal)
            || text.StartsWith(
                "The following message is a direct user message via channel;",
                StringComparison.Ordinal
            )
            || text.StartsWith("Channel is in push-only mode.", StringComparison.Ordinal)
            || text.StartsWith("Channel is in send-only mode.", StringComparison.Ordinal)
        )
            return null;
        return "[system] " + text;
    }

    internal bool Eligible(JsonObject message) => Item(message).Search.Length > 0;

    internal PreviewItem Item(JsonObject message, int? sourceIndex = null, string? sessionId = null)
    {
        var body = new List<string>();
        var search = new List<string>();
        var tool = new List<string>();
        var events = new List<PreviewTool>();
        var prose = false;
        var role = Text(message["role"]);
        foreach (var part in (message["parts"] as JsonArray)?.OfType<JsonObject>() ?? [])
        {
            var linked = role == "tool" || part["functionResponse"] is JsonObject;
            var textIncluded = parts.Contains(linked ? "tools" : "text");
            void AddText(string text)
            {
                if (!textIncluded || text.Length == 0)
                    return;
                body.Add(text);
                search.Add(text);
                if (linked)
                    tool.Add(text);
                else
                    prose = true;
            }
            if (SessionWait.Text(part["system"]) is string system && SystemText(system) is string visible)
                AddText(visible);
            if (SessionWait.Text(part["text"]) is string text
                && !text.Contains("--- RELEVANT MEMORY SNIPPETS (RAG) ---", StringComparison.Ordinal))
                AddText(SessionGoal.Trim(text));
            var image = part["inlineDataRef"] as JsonObject ?? part["inlineData"] as JsonObject;
            if (image is not null && parts.Contains(linked || part["functionCall"] is JsonObject ? "tools" : "images"))
            {
                var line = "[image:" + (SessionWait.Text(image["mimeType"])
                    ?? SessionWait.Text(image["mime_type"]) ?? "application/octet-stream") + "]";
                var imageId = SessionWait.Text(image["imageId"])
                    ?? SessionWait.Text((part["imageMeta"] as JsonObject)?["imageId"]);
                if (imageId is not null)
                    line += " " + imageId;
                body.Add(line);
                search.Add(line);
                if (!linked && part["functionCall"] is null)
                    prose = true;
            }
            if (!parts.Contains("tools"))
                continue;
            if (part["functionCall"] is JsonObject call)
            {
                var name = Text(call["name"]);
                var args = Args(call);
                var line = $"[call:{name}] {args}";
                events.Add(new(name, SessionWait.Text(call["id"]), false, false));
                tool.Add(name + "\n" + args);
                search.Add(name + "\n" + args);
                if (detail != "names")
                    body.Add(detail == "full" ? line : $"[call:{name}] " + Snippet(args, Active ? 360 : 240));
            }
            if (part["functionResponse"] is JsonObject response)
            {
                var name = SessionWait.Text(response["name"]) ?? "unknown";
                var content = Response(response);
                var line = $"[tool:{name}] {content}";
                events.Add(new(name, SessionWait.Text(response["tool_use_id"]), true,
                    (response["response"] as JsonObject)?["error"] is not null));
                tool.Add(name + "\n" + content);
                search.Add(name + "\n" + content);
                if (detail != "names")
                    body.Add(detail == "full" ? line : $"[tool:{name}] " + Snippet(content, Active ? 420 : 260));
            }
        }
        var meta = message["__meta"] as JsonObject;
        var block = meta?["contextBlock"] as JsonObject;
        var identity = block is not null ? "CTX B#" + Unknown(block["id"])
            : SessionWait.Number(meta?["seq"]) is { } seq ? "#" + EcmaNumber.Format(seq) : "unsequenced";
        var time = Time(SessionWait.Number(meta?["timestamp"]));
        var visibility = message["modelVisible"] is JsonValue flag
            && flag.TryGetValue<bool>(out var value) && !value ? " [non-context]" : "";
        string? drill = null;
        if (sessionId is not null && (block is not null || SessionWait.Number(meta?["seq"]) is not null))
            drill = ArchiveDrill(sessionId, block is not null ? "B#" + Unknown(block["id"]) : "msg#" + Unknown(meta?["seq"]));
        var item = new PreviewItem($"[{identity}{time}] {role}{visibility}:",
            string.Join('\n', body), string.Join('\n', search),
            detail != "full" ? string.Join('\n', tool) : null,
            Tools: events, ToolOnly: !prose && events.Count > 0, SourceIndex: sourceIndex, DrillDown: drill,
            UnfoldedBody: string.Join('\n', body), ArchiveSession: sessionId,
            Sequence: (long?)SessionWait.Number(meta?["seq"]), EndSequence: (long?)SessionWait.Number(meta?["seq"]));
        return detail == "names" && events.Count > 0
            ? item with { Body = JoinBody(item.Body, ToolSummary(events, events)) } : item;
    }

    internal static string Time(double? stamp) => stamp is null ? ""
        : " time " + (stamp >= DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
            && stamp <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds()
            ? DateTimeOffset.FromUnixTimeMilliseconds((long)stamp.Value).ToString("O")
            : EcmaNumber.Format(stamp.Value) + " ms");

    internal static string ArchiveDrill(string sessionId, string target) =>
        "recall(" + EcmaJson.Stringify(new JsonObject {
            ["sessionId"] = sessionId, ["target"] = target,
            ["toolDetail"] = "full", ["previewLength"] = 20000
        }) + ")";

    private static string JoinBody(string text, string summary) =>
        text.Length == 0 ? summary : text + "\n" + summary;

    private static string ToolSummary(IReadOnlyList<PreviewTool> events, IReadOnlyList<PreviewTool> page)
    {
        bool Paired(PreviewTool item) => item.Id is not null
            && page.Count(other => other.Id == item.Id && other.Name == item.Name && !other.Result) == 1
            && page.Count(other => other.Id == item.Id && other.Name == item.Name && other.Result) == 1;
        return "Tools: " + string.Join(" · ", events.GroupBy(item => item.Name).Select(group =>
        {
            var calls = group.Count(item => !item.Result);
            var results = group.Where(item => item.Result).ToArray();
            var unpaired = group.Count(item => !Paired(item));
            var errors = results.Count(item => item.Error);
            return group.Key + (calls > 0 ? " ×" + calls : " results")
                + (errors > 0 ? $" ({errors} error(s))" : "")
                + (unpaired > 0 ? $" ({unpaired} partial/unpaired)" : "");
        }));
    }

    private PreviewItem[] GroupTools(PreviewItem[] items)
    {
        if (detail != "names")
            return items;
        var page = items.SelectMany(item => item.Tools ?? []).ToArray();
        var groups = new List<PreviewItem>();
        for (var index = 0; index < items.Length; index++)
        {
            var item = items[index];
            if (!item.ToolOnly)
            {
                groups.Add(item.Tools is { Count: > 0 } mixedTools
                    ? item with { Body = JoinBody(item.UnfoldedBody ?? "", ToolSummary(mixedTools, page)) }
                    : item);
                continue;
            }
            var end = index;
            while (end + 1 < items.Length && items[end + 1].ToolOnly
                && items[end].SourceIndex is { } previous && items[end + 1].SourceIndex == previous + 1)
                end++;
            var members = items[index..(end + 1)];
            var tools = members.SelectMany(member => member.Tools ?? []).ToArray();
            groups.Add(item with {
                Heading = end == index ? item.Heading : item.Heading + " — " + items[end].Heading,
                Body = ToolSummary(tools, page),
                OmittedTools = string.Join('\n', members.Select(member => member.OmittedTools)),
                DrillDown = item.ArchiveSession is { } session && item.Sequence is { } first
                    && items[end].EndSequence is { } last
                    ? ArchiveDrill(session, $"msg#{first}-{last}") : item.DrillDown,
                EndSequence = items[end].EndSequence
            });
            index = end;
        }
        return groups.ToArray();
    }
}
