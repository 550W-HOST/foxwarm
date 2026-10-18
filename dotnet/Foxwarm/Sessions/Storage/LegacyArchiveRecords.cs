using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

// Migration-only Source JSONL shapes are intentionally not the stricter active
// Session message/block construction contracts. Old rows are never rewritten.
internal static class LegacyArchiveRecords
{
    internal sealed record Parsed(JsonObject Record, bool Recovered = false);

    private const string Signature = "{\"v\":1,\"kind\":\"message\"";
    private static readonly Regex Header = new(
        "^\\{\"v\":1,\"kind\":\"message\",\"sessionId\":(\"(?:\\\\.|[^\"\\\\])*\"),\"agent\":(\"(?:\\\\.|[^\"\\\\])*\"),\"seq\":([1-9]\\d*),"
    );

    internal static async IAsyncEnumerable<string> Lines(string path)
    {
        using var reader = new StreamReader(
            path,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: false
        );
        var buffer = new char[8192];
        var line = new StringBuilder();
        int count;
        while ((count = await reader.ReadAsync(buffer)) > 0)
            for (var index = 0; index < count; index++)
                if (buffer[index] == '\n')
                {
                    var text = OpenAIRequestText.Trim(line.ToString());
                    line.Clear();
                    if (text.Length > 0)
                        yield return text;
                }
                else
                    line.Append(buffer[index]);
        var tail = OpenAIRequestText.Trim(line.ToString());
        if (tail.Length > 0)
            yield return tail;
    }

    internal static Parsed Parse(string line, bool blocks)
    {
        try
        {
            if (JsonNode.Parse(line) is JsonObject obj && Valid(obj, blocks))
                return new(obj);
            throw new InvalidDataException("Invalid legacy session archive record.");
        }
        catch (JsonException) when (!blocks)
        {
            var header = Header.Match(line);
            if (header.Success)
            {
                var candidates = new List<(int Index, JsonObject Record)>();
                var start = 1;
                while ((start = line.IndexOf(Signature, start, StringComparison.Ordinal)) >= 0)
                {
                    try
                    {
                        if (JsonNode.Parse(line[start..]) is JsonObject obj && Valid(obj, false))
                            candidates.Add((start, obj));
                    }
                    catch (JsonException) { }
                    start++;
                }
                if (
                    candidates is [(var index, var record)]
                    && TornInsideString(line[..index])
                    && Text(record, "sessionId")
                        == JsonSerializer.Deserialize<string>(header.Groups[1].Value)
                    && Number(record["seq"])
                        == double.Parse(
                            header.Groups[3].Value,
                            System.Globalization.CultureInfo.InvariantCulture
                        )
                )
                    return new(record, true);
            }
            throw new InvalidDataException("Malformed legacy session archive line.");
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("Malformed legacy block archive line.", error);
        }
    }

    private static bool TornInsideString(string prefix)
    {
        try
        {
            JsonNode.Parse(prefix);
            return false;
        }
        catch (JsonException error)
        {
            if (error.BytePositionInLine != Encoding.UTF8.GetByteCount(prefix))
                return false;
        }
        var inside = false;
        var escape = false;
        foreach (var c in prefix)
        {
            if (escape)
            {
                escape = false;
                continue;
            }
            if (inside && c == '\\')
            {
                escape = true;
                continue;
            }
            if (c == '"')
                inside = !inside;
        }
        return inside;
    }

    internal static string? Text(JsonObject value, string key) => SessionWait.Text(value[key]);

    internal static double? Number(JsonNode? value) => SessionWait.Number(value);

    private static bool Finite(JsonNode? value) => Number(value) is { } n && double.IsFinite(n);

    private static bool Positive(JsonNode? value) =>
        Number(value) is > 0 and var n && double.IsFinite(n) && Math.Floor(n) == n;

    private static bool Optional(JsonObject obj, string key, Func<JsonNode?, bool> valid) =>
        !obj.ContainsKey(key) || valid(obj[key]);

    private static bool String(JsonNode? value) =>
        value is JsonValue v && v.TryGetValue<string>(out _);

    private static bool Boolean(JsonNode? value) =>
        value is JsonValue v && v.TryGetValue<bool>(out _);

    private static bool Valid(JsonObject record, bool blocks)
    {
        if (
            Number(record["v"]) != 1
            || Text(record, "kind") != (blocks ? "block" : "message")
            || Text(record, "sessionId") is not { Length: > 0 }
            || Text(record, "agent") is not { Length: > 0 }
        )
            return false;
        if (!blocks)
            return Positive(record["seq"])
                && Finite(record["timestamp"])
                && Text(record, "role") is "user" or "model" or "tool"
                && record["message"] is JsonObject message
                && ValidMessage(message)
                && Text(record, "role") == Text(message, "role");
        if (
            !new[] { "id", "level", "sourceStart", "sourceEnd", "rawStartSeq", "rawEndSeq" }.All(
                key => Positive(record[key])
            )
            || Number(record["rawStartSeq"]) > Number(record["rawEndSeq"])
            || Text(record, "sourceKind") is not ("message" or "block")
            || !String(record["summary"])
            || !Finite(record["createdAt"])
        )
            return false;
        if (
            record.ContainsKey("sourceBlockIds")
            && (record["sourceBlockIds"] is not JsonArray list || !list.All(Positive))
        )
            return false;
        if (Text(record, "sourceKind") == "message")
        {
            if (
                Number(record["sourceStart"]) > Number(record["sourceEnd"])
                || record.ContainsKey("sourceBlockIds")
            )
                return false;
        }
        else if (record["sourceBlockIds"] is JsonArray ids)
        {
            if (
                ids.Count == 0
                || Number(ids[0]) != Number(record["sourceStart"])
                || Number(ids[^1]) != Number(record["sourceEnd"])
                || ids.Select(Number).Distinct().Count() != ids.Count
            )
                return false;
        }
        else if (Number(record["sourceStart"]) > Number(record["sourceEnd"]))
            return false;
        return Optional(record, "rawStartTimestamp", Finite)
            && Optional(record, "rawEndTimestamp", Finite)
            && Optional(
                record,
                "memoryFacts",
                node => node is JsonArray facts && facts.All(ValidFact)
            );
    }

    private static bool ValidMessage(JsonObject message)
    {
        if (
            Text(message, "role") is not ("user" or "model" or "tool")
            || message["parts"] is not JsonArray parts
            || !Optional(message, "modelVisible", Boolean)
            || !Optional(message, "__meta", node => node is JsonObject)
            || !Optional(
                message,
                "providerMeta",
                node =>
                    node is JsonObject meta
                    && meta["providerSpecificFields"] is JsonObject
                    && Optional(meta, "sourceModelId", String)
            )
        )
            return false;
        return parts.All(node =>
            node is JsonObject part
            && new[] { "text", "system", "thinking", "toolUseId" }.All(key =>
                Optional(part, key, String)
            )
            && Optional(
                part,
                "phase",
                node => SessionWait.Text(node) is "commentary" or "final_answer"
            )
            && Optional(part, "systemPayload", Boolean)
            && Optional(
                part,
                "functionCall",
                node =>
                    node is JsonObject call
                    && String(call["id"])
                    && String(call["name"])
                    && call["args"] is JsonObject
            )
            && Optional(
                part,
                "functionResponse",
                node =>
                    node is JsonObject response
                    && String(response["tool_use_id"])
                    && String(response["name"])
                    && response.ContainsKey("response")
            )
            && Optional(part, "inlineData", node => node is JsonObject data && String(data["data"]))
            && Optional(
                part,
                "inlineDataRef",
                node =>
                    node is JsonObject data
                    && String(data["imageId"])
                    && String(data["mimeType"])
                    && Finite(data["byteLength"])
                    && String(data["sha256"])
            )
            && Optional(
                part,
                "imageMeta",
                node => node is JsonObject meta && String(meta["imageId"])
            )
            && Optional(part, "providerMeta", node => node is JsonObject)
        );
    }

    private static bool ValidFact(JsonNode? node) =>
        node is JsonObject fact
        && Text(fact, "kind")
            is "decision"
                or "preference"
                or "fact"
                or "convention"
                or "environment"
        && String(fact["text"])
        && Optional(fact, "context", String)
        && Optional(
            fact,
            "attributedTo",
            node => SessionWait.Text(node) is "user" or "assistant" or "both"
        );

    internal static int? Friction(JsonNode? node) =>
        Number(node) is >= 0 and <= 100 and var n && Math.Floor(n) == n ? (int)n : null;

    private static double? JsonNumber(JsonNode? node)
    {
        if (node is null)
            return 0;
        if (node is JsonValue value && value.TryGetValue<bool>(out var boolean))
            return boolean ? 1 : 0;
        if (SessionWait.Number(node) is { } number)
            return number;
        var text = node is JsonArray array
            ? string.Join(",", array.Select(value => value?.ToString() ?? ""))
            : node.ToString();
        return double.TryParse(
            text.Trim(),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out var parsed
        )
            ? parsed
            : null;
    }

    internal static JsonArray? SourceBlockIds(string? json)
    {
        try
        {
            if (json is null || JsonNode.Parse(json) is not JsonArray array)
                return null;
            var values = array
                .Select(node => JsonNumber(node))
                .Where(n => n is > 0 && double.IsFinite(n.Value) && Math.Floor(n.Value) == n.Value)
                .Select(n => JsonValue.Create(n!.Value))
                .ToArray();
            return values.Length > 0 ? new JsonArray(values) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static JsonArray? MemoryFacts(string? json)
    {
        try
        {
            if (json is null || JsonNode.Parse(json) is not JsonArray array)
                return null;
            var result = new JsonArray();
            foreach (var node in array.OfType<JsonObject>())
            {
                if (
                    Text(node, "kind")
                        is not (
                            "decision"
                            or "preference"
                            or "fact"
                            or "convention"
                            or "environment"
                        )
                    || Text(node, "text") is not { } text
                    || OpenAIRequestText.Trim(text).Length == 0
                )
                    continue;
                var fact = new JsonObject { ["kind"] = Text(node, "kind"), ["text"] = text };
                if (
                    Text(node, "context") is { } context
                    && OpenAIRequestText.Trim(context).Length > 0
                )
                    fact["context"] = context;
                if (Text(node, "attributedTo") is "user" or "assistant" or "both")
                    fact["attributedTo"] = Text(node, "attributedTo");
                result.Add(fact);
            }
            return result.Count > 0 ? result : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    internal static string Canonical(JsonNode? node)
    {
        JsonNode? Sort(JsonNode? value) =>
            value switch
            {
                JsonObject obj => new JsonObject(
                    obj.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                        .Select(pair => KeyValuePair.Create(pair.Key, Sort(pair.Value)))
                ),
                JsonArray array => new JsonArray(array.Select(Sort).ToArray()),
                _ => value?.DeepClone(),
            };
        return node is null ? "null" : LlmRequestJournalStore.EncodeCli(Sort(node)!);
    }
}
