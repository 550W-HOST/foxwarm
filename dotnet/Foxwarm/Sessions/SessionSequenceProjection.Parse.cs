using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Foxwarm.Sessions;

// Normalizes extracted Archive rows into lane events. These readers only accept the trusted
// first-party shapes written by Foxwarm (tool metadata and leading transport wrappers).
internal sealed partial class SessionSequenceProjection
{
    internal sealed record Wrapper(
        string Tag,
        IReadOnlyDictionary<string, string> Attributes,
        string Body
    );

    private static readonly Regex Attribute = new(
        "\\s([A-Za-z][A-Za-z0-9_-]*)=\"([^\"]*)\"",
        RegexOptions.CultureInvariant
    );

    /// <summary>Parses only a leading <c>foxwarm-message</c>/<c>foxwarm-system</c> opening tag.</summary>
    internal static Wrapper? ParseWrapper(string text)
    {
        var trimmed = text.TrimStart();
        string tag;
        if (trimmed.StartsWith("<foxwarm-message", StringComparison.Ordinal))
            tag = "foxwarm-message";
        else if (trimmed.StartsWith("<foxwarm-system", StringComparison.Ordinal))
            tag = "foxwarm-system";
        else
            return null;
        var end = trimmed.IndexOf('>');
        if (end < 0)
            return null;
        var opening = trimmed[..end];
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Match match in Attribute.Matches(opening))
            attributes.TryAdd(match.Groups[1].Value, WebUtility.HtmlDecode(match.Groups[2].Value));
        var body = trimmed[(end + 1)..].TrimStart('\r', '\n');
        var close = body.LastIndexOf("</" + tag + ">", StringComparison.Ordinal);
        if (close >= 0)
            body = body[..close];
        return new(tag, attributes, body.TrimEnd());
    }

    /// <summary>Parses the wrapper <c>time</c> attribute (<c>yyyy-MM-dd HH:mm:ss +zzzz</c>).</summary>
    internal static double? WrapperTime(string? value)
    {
        if (value is null)
            return null;
        var match = Regex.Match(
            value,
            "^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}) ([+-])(\\d{2}):?(\\d{2})$"
        );
        if (
            !match.Success
            || !DateTime.TryParseExact(
                match.Groups[1].Value,
                "yyyy-MM-dd HH:mm:ss",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out var local
            )
        )
            return null;
        var offset = new TimeSpan(
            int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture),
            int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture),
            0
        );
        if (match.Groups[2].Value == "-")
            offset = -offset;
        try
        {
            return new DateTimeOffset(local, offset).ToUnixTimeMilliseconds();
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    internal sealed record DeliveryAnchor(long Seq, int Call, int? SubCall);

    /// <summary>Parses <c>seq</c>, <c>seq.k</c> or <c>seq.k.n...</c>; <c>ts:</c> IDs have no anchor.</summary>
    internal static DeliveryAnchor? ParseDeliverySeq(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.StartsWith("ts:", StringComparison.Ordinal))
            return null;
        var parts = value.Split('.');
        if (!long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var seq))
            return null;
        var call = 1;
        if (
            parts.Length > 1
            && !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out call)
        )
            return null;
        int? sub = null;
        if (
            parts.Length > 2
            && int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var n)
        )
            sub = n;
        return new(seq, call, sub);
    }

    private static string Preview(string? text, int length = SqliteArchiveSequence.PreviewLength)
    {
        if (string.IsNullOrEmpty(text))
            return "";
        var collapsed = Regex.Replace(text, "\\s+", " ").Trim();
        return collapsed.Length <= length ? collapsed : collapsed[..(length - 1)] + "…";
    }

    private static string? Str(JsonNode? node) => SessionWait.Text(node);

    private static double? Num(JsonNode? node) => SessionCatalog.Number(node);

    // call_tool is shown as the concrete tool it dispatched to.
    private static (string Name, JsonObject Args) Concrete(JsonObject call)
    {
        var name = Str(call["name"]) ?? "tool";
        var args = call["args"] as JsonObject ?? new JsonObject();
        if (name != "call_tool")
            return (name, args);
        var inner = call["inner"] as JsonObject ?? new JsonObject();
        var toolId = Str(args["toolId"]);
        var concrete =
            toolId is not null && toolId.Contains(':', StringComparison.Ordinal)
                ? toolId[(toolId.IndexOf(':') + 1)..]
                : Str(args["name"]) ?? toolId ?? "call_tool";
        if (concrete.Contains('/', StringComparison.Ordinal))
            concrete = concrete[(concrete.LastIndexOf('/') + 1)..];
        return (concrete, inner);
    }

    private static string ArgsPreview(string name, JsonObject args)
    {
        string? value = name switch
        {
            "send_to_session" => Join(Str(args["sessionId"]), Str(args["message"])),
            "create_child_session" => Join(
                Str(args["suffix"]) ?? Str(args["agentName"]),
                Str(args["message"]) ?? Str(args["taskId"])
            ),
            "task" => Join(Str(args["action"]), Str(args["title"]) ?? Str(args["taskId"])),
            "exec" => Str(args["command"]),
            "run_script" or "start_toolscript_run" => Str(args["code"]) ?? Str(args["filePath"]),
            _ => Str(args["filePath"])
                ?? Str(args["command"])
                ?? Str(args["sessionId"])
                ?? Str(args["action"]),
        };
        return Preview(value, 160);

        static string? Join(string? left, string? right) =>
            left is null ? right
            : right is null ? left
            : left + " · " + right;
    }
}
