using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Hosted.Postgres.Archive;

/// <summary>
/// The small per-row object the WebUI sequence view reads (<see cref="Foxwarm.Sessions.ArchiveSequenceRow.Data"/>),
/// computed once when the row is inserted. It reproduces the JSON projection that the SQLite
/// sequence reader runs inside SQLite, including that engine's value conversions: a boolean
/// read as a scalar becomes 1 or 0, a non-integral number read as a scalar becomes its double
/// value, objects and arrays are copied as they are, and text is cut by code
/// points. The one deliberate difference: where SQLite fails the whole read because a
/// delivery list holds a bare string, this projection gives that entry null fields.
/// </summary>
internal static class ArchiveSequenceProjection
{
    private const int PreviewLength = Foxwarm.Sessions.SqliteArchiveSequence.PreviewLength;
    private const int CtlCommandLength = 4000;
    private const int CtlValuesLength = 8192;

    private static readonly (string Key, int Length)[] ArgFields =
    [
        ("sessionId", 512),
        ("message", PreviewLength),
        ("toolId", 256),
        ("name", 256),
        ("source", 32),
        ("suffix", 128),
        ("agentName", 128),
        ("taskId", 128),
        ("action", 64),
        ("title", 200),
        ("ownerSessionId", 512),
        ("command", 200),
        ("filePath", 300),
        ("code", 200),
    ];

    /// <summary>The projection of one stored row, serialized.</summary>
    internal static string Project(string role, string messageJson) =>
        Foxwarm.Sessions.EcmaJson.Stringify(
            Build(role, JsonNode.Parse(messageJson) as JsonObject ?? new JsonObject())
        );

    internal static JsonObject Build(string role, JsonObject message)
    {
        var parts = (message["parts"] as JsonArray)?.ToArray() ?? [];
        return role switch
        {
            "model" => Model(message, parts),
            "tool" => Tool(parts),
            _ => Other(message, parts),
        };
    }

    private static JsonObject Model(JsonObject message, JsonNode?[] parts)
    {
        var texts = parts.Where(part => IsText(Path(part, "text")) && !Exists(part, "thinking")).ToArray();
        var calls = new JsonArray();
        foreach (var part in parts)
        {
            if (Path(part, "functionCall") is not JsonObject call)
                continue;
            var name = Path(call, "name");
            calls.Add(
                new JsonObject
                {
                    ["id"] = Scalar(Path(call, "id")),
                    ["name"] = Scalar(name),
                    ["args"] = Args(Path(call, "args")),
                    ["inner"] = Args(Path(call, "args", "args")),
                    ["ctl"] = IsText(name) && name!.GetValue<string>() == "ctl" ? Ctl(Path(call, "args")) : null,
                }
            );
        }
        return new JsonObject
        {
            ["timing"] = Scalar(Path(message, "__meta", "llmRequestTiming")),
            ["visible"] = Scalar(Path(message, "modelVisible")),
            ["notice"] = Scalar(Path(message, "__meta", "noticeType")),
            ["text"] = Joined(texts, "", PreviewLength),
            ["phase"] = texts.Length == 0 ? null : Scalar(Path(texts[^1], "phase")),
            ["calls"] = calls,
        };
    }

    private static JsonObject Ctl(JsonNode? args)
    {
        var values = Path(args, "values");
        return new JsonObject
        {
            ["command"] = Text(Path(args, "command"), CtlCommandLength),
            ["values"] =
                values is JsonObject
                && CodePoints(Foxwarm.Sessions.EcmaJson.Stringify(values)) <= CtlValuesLength
                    ? values.DeepClone()
                    : null,
            ["valuesJson"] = Text(Path(args, "valuesJson"), CtlValuesLength),
        };
    }

    private static JsonObject Args(JsonNode? args)
    {
        var result = new JsonObject();
        foreach (var (key, length) in ArgFields)
            result[key] = Text(Path(args, key), length);
        return result;
    }

    private static JsonObject Tool(JsonNode?[] parts)
    {
        var responses = new JsonArray();
        foreach (var part in parts)
        {
            if (Path(part, "functionResponse") is not JsonObject response)
                continue;
            var failed = Exists(Path(response, "response"), "error");
            responses.Add(
                new JsonObject
                {
                    ["id"] = Scalar(Path(response, "tool_use_id")),
                    ["name"] = Scalar(Path(response, "name")),
                    ["timing"] = Scalar(Path(response, "executionTiming")),
                    ["error"] = failed
                        ? Scalar(Path(response, "response", "code"))
                            ?? Scalar(Path(response, "response", "error", "type"))
                        : null,
                    ["failed"] = failed ? 1 : 0,
                    ["canceled"] = Scalar(Path(response, "response", "canceled")),
                    ["deliveries"] = Each(
                        Path(response, "__meta", "sessionMessages"),
                        Exists(Path(response, "__meta"), "sessionMessages"),
                        value => new JsonObject
                        {
                            ["target"] = Scalar(Path(value, "targetSessionId")),
                            ["deliverySeq"] = Scalar(Path(value, "deliverySeq")),
                            ["message"] = Text(Path(value, "message"), PreviewLength),
                        }
                    ),
                    ["subCalls"] = Each(
                        Path(response, "__meta", "toolScriptSubCalls"),
                        Exists(Path(response, "__meta"), "toolScriptSubCalls"),
                        value => new JsonObject
                        {
                            ["name"] = Scalar(Path(value, "name")),
                            ["status"] = Scalar(Path(value, "status")),
                            ["startedAt"] = Scalar(Path(value, "startedAt")),
                            ["durationMs"] = Scalar(Path(value, "durationMs")),
                            ["target"] = Scalar(Path(value, "sessionMessage", "targetSessionId")),
                            ["deliverySeq"] = Scalar(Path(value, "sessionMessage", "deliverySeq")),
                            ["message"] = Text(Path(value, "sessionMessage", "message"), PreviewLength),
                        }
                    ),
                }
            );
        }
        return new JsonObject { ["responses"] = responses };
    }

    private static JsonObject Other(JsonObject message, JsonNode?[] parts)
    {
        var system = new JsonArray();
        foreach (var part in parts)
            if (IsText(Path(part, "system")))
                system.Add(JsonValue.Create(Text(Path(part, "system"), 1600)));
        return new JsonObject
        {
            ["system"] = system,
            ["text"] = Joined(parts.Where(part => IsText(Path(part, "text"))), " ", PreviewLength),
            ["visible"] = Scalar(Path(message, "modelVisible")),
        };
    }

    // json_each over a path: an array yields its elements, an object its member values, and a
    // present non-container value (JSON null included) yields itself once; a missing path, none.
    private static JsonArray Each(JsonNode? value, bool exists, Func<JsonNode?, JsonObject> project)
    {
        var result = new JsonArray();
        if (!exists)
            return result;
        IEnumerable<JsonNode?> items = value switch
        {
            JsonArray array => array,
            JsonObject members => members.Select(member => member.Value),
            _ => [value],
        };
        foreach (var item in items)
            result.Add(project(item));
        return result;
    }

    private static JsonNode? Path(JsonNode? node, params string[] keys)
    {
        foreach (var key in keys)
        {
            if (node is not JsonObject obj || !obj.TryGetPropertyValue(key, out node))
                return null;
        }
        return node;
    }

    private static bool Exists(JsonNode? node, string key) =>
        node is JsonObject obj && obj.ContainsKey(key);

    private static bool IsText(JsonNode? node) =>
        node is JsonValue value && value.GetValueKind() == JsonValueKind.String;

    private static string? Text(JsonNode? node, int length) =>
        IsText(node) ? Truncate(node!.GetValue<string>(), length) : null;

    private static string? Joined(IEnumerable<JsonNode?> parts, string separator, int length)
    {
        var texts = parts.Select(part => Path(part, "text")!.GetValue<string>()).ToArray();
        return texts.Length == 0 ? null : Truncate(string.Join(separator, texts), length);
    }

    // A value read as a scalar and placed in an object, as SQLite does it.
    private static JsonNode? Scalar(JsonNode? node)
    {
        if (node is null)
            return null;
        if (node is not JsonValue value)
            return node.DeepClone();
        switch (value.GetValueKind())
        {
            case JsonValueKind.True:
                return JsonValue.Create(1);
            case JsonValueKind.False:
                return JsonValue.Create(0);
            case JsonValueKind.Null:
                return null;
            case JsonValueKind.Number:
                var literal = value.ToJsonString();
                if (literal.IndexOfAny(['.', 'e', 'E']) < 0)
                    return value.DeepClone();
                return JsonValue.Create(double.Parse(literal, CultureInfo.InvariantCulture));
            default:
                return value.DeepClone();
        }
    }

    // SQLite counts and cuts text by code points.
    private static int CodePoints(string text)
    {
        var count = 0;
        for (var index = 0; index < text.Length; index++, count++)
            if (char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]))
                index++;
        return count;
    }

    private static string Truncate(string text, int length)
    {
        var index = 0;
        for (var count = 0; count < length && index < text.Length; count++)
            index += char.IsHighSurrogate(text[index]) && index + 1 < text.Length && char.IsLowSurrogate(text[index + 1]) ? 2 : 1;
        return index >= text.Length ? text : text[..index];
    }
}
