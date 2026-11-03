using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

internal sealed record PreviewTool(
    string Name,
    string? Id,
    bool Result,
    string Summary = "",
    string Status = ""
);

internal sealed record PreviewItem(
    string Heading,
    string Body,
    string Search,
    string? OmittedTools,
    IReadOnlyList<string>? PriorityNotices = null,
    IReadOnlyList<PreviewTool>? Tools = null,
    bool ToolOnly = false,
    string? DrillDown = null,
    string? UnfoldedBody = null,
    long? Sequence = null,
    string ActivityTime = "",
    string ActivityLocator = ""
);

internal sealed partial class ContextPreviewRenderer
{
    private static string Text(JsonNode? node) => SessionWait.Text(node) ?? "";

    private static string Unknown(JsonNode? node) =>
        node is null ? "" : SessionWait.Text(node) ?? EcmaJson.Stringify(node);

    private static string Args(JsonObject call) =>
        SessionWait.Text(call["rawArgsText"])
        ?? (call["args"] is null ? "{}" : EcmaJson.Stringify(call["args"]!));

    private static bool McpError(JsonObject? value) =>
        value?["isError"] is JsonValue flag && flag.TryGetValue<bool>(out var error) && error;

    private static string Response(JsonObject response)
    {
        response = (JsonObject)Foxwarm.Images.ImageTransport.Project(response)!;
        if (response["response"] is not JsonObject value)
            return Unknown(response["response"]);
        if (value["error"] is not null)
            return "ERROR: " + Unknown(value["error"]);
        if (McpError(value))
            return "ERROR: " + Unknown(value);
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
                if (!linked || detail != "names")
                    body.Add(text);
                search.Add(text);
                if (linked)
                    tool.Add(text);
                else
                    prose = true;
            }
            if (
                SessionWait.Text(part["system"]) is string system
                && SystemText(system) is string visible
            )
                AddText(visible);
            if (
                SessionWait.Text(part["text"]) is string text
                && !text.Contains(
                    "--- RELEVANT MEMORY SNIPPETS (RAG) ---",
                    StringComparison.Ordinal
                )
            )
                AddText(SessionGoal.Trim(text));
            var image = part["inlineDataRef"] as JsonObject ?? part["inlineData"] as JsonObject;
            if (
                image is not null
                && parts.Contains(linked || part["functionCall"] is JsonObject ? "tools" : "images")
            )
            {
                var line =
                    "[image:"
                    + (
                        SessionWait.Text(image["mimeType"])
                        ?? SessionWait.Text(image["mime_type"])
                        ?? "application/octet-stream"
                    )
                    + "]";
                var imageId =
                    SessionWait.Text(image["imageId"])
                    ?? SessionWait.Text((part["imageMeta"] as JsonObject)?["imageId"]);
                if (imageId is not null)
                    line += " " + imageId;
                if (!linked || detail != "names")
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
                var target = ToolActivity.Target(
                    name,
                    call["args"] as JsonObject ?? new JsonObject()
                );
                events.Add(
                    new(
                        target.Name,
                        SessionWait.Text(call["id"]),
                        false,
                        ToolActivity.Summary(target.Name, target.Args)
                    )
                );
                tool.Add(name + "\n" + args);
                search.Add(name + "\n" + args);
                if (detail != "names")
                    body.Add(
                        detail == "full"
                            ? line
                            : $"[call:{name}] " + Snippet(args, Active ? 360 : 240)
                    );
            }
            if (part["functionResponse"] is JsonObject response)
            {
                var name = SessionWait.Text(response["name"]) ?? "unknown";
                var content = Response(response);
                var line = $"[tool:{name}] {content}";
                events.Add(
                    new(
                        name,
                        SessionWait.Text(response["tool_use_id"]),
                        true,
                        Status: ResultStatus(response["response"] as JsonObject)
                    )
                );
                tool.Add(name + "\n" + content);
                search.Add(name + "\n" + content);
                if (detail != "names")
                    body.Add(
                        detail == "full"
                            ? line
                            : $"[tool:{name}] " + Snippet(content, Active ? 420 : 260)
                    );
            }
        }
        var meta = message["__meta"] as JsonObject;
        var block = meta?["contextBlock"] as JsonObject;
        var identity =
            block is not null ? "CTX B#" + Unknown(block["id"])
            : SessionWait.Number(meta?["seq"]) is { } seq ? "#" + EcmaNumber.Format(seq)
            : sourceIndex is { } index ? "source " + index
            : "unsequenced";
        var time = Time(SessionWait.Number(meta?["timestamp"]));
        var visibility = Visibility(message);
        string? drill = null;
        if (
            !externalRead
            && sessionId is not null
            && (block is not null || SessionWait.Number(meta?["seq"]) is not null)
        )
            drill = ArchiveDrill(
                sessionId,
                block is not null ? "B#" + Unknown(block["id"]) : "msg#" + Unknown(meta?["seq"])
            );
        var item = new PreviewItem(
            $"[{identity}{time}] {role}{visibility}:",
            string.Join('\n', body),
            string.Join('\n', search),
            detail != "full" ? string.Join('\n', tool) : null,
            Tools: events,
            ToolOnly: !prose && events.Count > 0,
            DrillDown: drill,
            UnfoldedBody: string.Join('\n', body),
            Sequence: (long?)SessionWait.Number(meta?["seq"]),
            ActivityTime: time.Length > 0 ? time[6..] + " " : "",
            ActivityLocator: "(" + identity + ")" + visibility
        );
        return detail == "names" && events.Count > 0 ? GroupTools([item])[0] : item;
    }

    private static string Visibility(JsonObject message) =>
        message["modelVisible"] is JsonValue flag
        && flag.TryGetValue<bool>(out var visible)
        && !visible
            ? " [non-context]"
            : "";

    internal static string Time(double? stamp) =>
        stamp is null
            ? ""
            : " time "
                + (
                    stamp >= DateTimeOffset.MinValue.ToUnixTimeMilliseconds()
                    && stamp <= DateTimeOffset.MaxValue.ToUnixTimeMilliseconds()
                        ? DateTimeOffset
                            .FromUnixTimeMilliseconds((long)stamp.Value)
                            .UtcDateTime.ToString(
                                "yyyy-MM-dd HH:mm:ss'Z'",
                                System.Globalization.CultureInfo.InvariantCulture
                            )
                        : EcmaNumber.Format(stamp.Value) + " ms"
                );

    internal static string ArchiveDrill(string sessionId, string target) =>
        "recall("
        + EcmaJson.Stringify(
            new JsonObject
            {
                ["sessionId"] = sessionId,
                ["target"] = target,
                ["toolDetail"] = "full",
                ["previewLength"] = 20000,
            }
        )
        + ")";

    private static string JoinBody(string text, string summary) =>
        text.Length == 0 ? summary : text + "\n" + summary;

    private static string ResultStatus(JsonObject? response)
    {
        if (response?["error"] is { } error)
            return "error: "
                + ToolActivity.SingleLine(
                    SessionWait.Text((error as JsonObject)?["message"]) ?? Unknown(error),
                    100
                );
        if (McpError(response))
            return "error";
        return SessionWait.Text(response?["status"]) is "running" or "background" ? "running" : "";
    }

    private static (PreviewTool Tool, PreviewItem Owner)? Pair(
        PreviewTool item,
        ILookup<string?, (PreviewTool Tool, PreviewItem Owner)> page
    )
    {
        if (item.Id is null)
            return null;
        var matches = page[item.Id].ToArray();
        return matches.Length == 2 && matches.Count(other => other.Tool.Result) == 1
            ? matches.Single(other => other.Tool.Result != item.Result)
            : null;
    }

    private static string ToolSummary(
        PreviewItem owner,
        IReadOnlyList<PreviewTool> events,
        ILookup<string?, (PreviewTool Tool, PreviewItem Owner)> page,
        string? runningCallId
    )
    {
        return string.Join(
            '\n',
            events
                .Select(item =>
                {
                    var pair = Pair(item, page);
                    if (item.Result && pair is not null)
                        return null;
                    var status = item.Result ? item.Status : pair?.Tool.Status;
                    if (
                        !item.Result
                        && pair is null
                        && item.Id is not null
                        && item.Id == runningCallId
                        && page[item.Id].Count() == 1
                    )
                        status = "running";
                    var locator = owner.ActivityLocator;
                    if (
                        !item.Result
                        && owner.Sequence is not null
                        && pair?.Owner.Sequence is { } resultSeq
                        && resultSeq != owner.Sequence
                    )
                        locator = locator.Replace(
                            ")",
                            "/#" + resultSeq + ")",
                            StringComparison.Ordinal
                        );
                    return (owner.ToolOnly ? owner.ActivityTime : "")
                        + item.Name
                        + (item.Summary.Length > 0 ? " — " + item.Summary : "")
                        + (string.IsNullOrEmpty(status) ? "" : " [" + status + "]")
                        + (item.Result && pair is null ? " [result only]" : "")
                        + " "
                        + locator;
                })
                .Where(line => line is not null)
        );
    }

    internal PreviewItem[] GroupTools(PreviewItem[] items, string? runningCallId = null)
    {
        if (detail != "names")
            return items;
        var page = items
            .SelectMany(owner => (owner.Tools ?? []).Select(tool => (Tool: tool, Owner: owner)))
            .ToLookup(entry => entry.Tool.Id);
        return items
            .Select(item =>
            {
                if (item.Tools is not { Count: > 0 } tools)
                    return item;
                var activity = ToolSummary(item, tools, page, runningCallId);
                return item with
                {
                    Heading = item.ToolOnly ? "" : item.Heading,
                    Body = JoinBody(item.UnfoldedBody ?? "", activity),
                    OmittedTools = string.Join(
                        '\n',
                        new[] { item.OmittedTools }.Concat(
                            tools
                                .Where(tool => !tool.Result)
                                .Select(tool => Pair(tool, page)?.Owner.OmittedTools)
                        )
                    ),
                };
            })
            .Where(item => item.Body.Length > 0 || !item.ToolOnly)
            .ToArray();
    }
}
