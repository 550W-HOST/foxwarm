using System.Text.Encodings.Web;
using System.Globalization;
using System.Numerics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.SessionPersistence;

public sealed class UnsupportedSessionAuthorityException : IOException
{
    public UnsupportedSessionAuthorityException(string message) : base(message) { }
}

public sealed class SessionAuthorityDocument
{
    private static readonly HashSet<string> ModelEfforts = ["none", "low", "medium", "high", "xhigh", "max"];
    private readonly JsonObject root;

    private SessionAuthorityDocument(JsonObject root, string sessionId, string agent)
    {
        Validate(root, sessionId, agent);
        this.root = (JsonObject)root.DeepClone();
        SessionId = sessionId;
        Agent = agent;
    }

    public string SessionId { get; }
    public string Agent { get; }
    public JsonObject CloneRoot() => (JsonObject)root.DeepClone();

    public static SessionAuthorityDocument Parse(string json, string sessionId, string agent = "main")
    {
        JsonNode? node;
        try { node = JsonNode.Parse(json); }
        catch (JsonException error) { throw new InvalidDataException("Session authority is not valid JSON.", error); }
        return FromOwned(node as JsonObject
            ?? throw new InvalidDataException("Session authority must be a JSON object."), sessionId, agent);
    }

    public static SessionAuthorityDocument FromOwned(JsonObject root, string sessionId, string agent = "main") =>
        new(root, sessionId, agent);

    public static SessionAuthorityDocument Load(string filePath, string sessionId, string agent = "main") =>
        Parse(File.ReadAllText(filePath), sessionId, agent);

    public string ToJson(bool indented = true) => root.ToJsonString(new JsonSerializerOptions
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = indented
    });

    internal static void ValidateMessage(JsonObject message, int expectedSeq, string label)
    {
        var role = RequiredString(message, "role", label);
        if (role is not ("user" or "model" or "tool"))
            throw new InvalidDataException($"{label}.role is unsupported.");
        var parts = message["parts"] as JsonArray
            ?? throw new InvalidDataException($"{label}.parts must be an array.");
        foreach (var (partNode, partIndex) in parts.Select((value, index) => (value, index)))
        {
            var part = partNode as JsonObject
                ?? throw new InvalidDataException($"{label}.parts[{partIndex}] must be an object.");
            foreach (var unsupported in new[] { "inlineData", "inlineDataRef", "imageMeta" })
                if (part.ContainsKey(unsupported))
                    throw new UnsupportedSessionAuthorityException($"{label}.parts[{partIndex}].{unsupported} is not supported by Slice C1.");
            if (part["functionCall"] is JsonNode callNode && callNode is not JsonObject)
                throw new InvalidDataException($"{label}.parts[{partIndex}].functionCall must be an object.");
            if (part["functionResponse"] is JsonNode responseNode && responseNode is not JsonObject)
                throw new InvalidDataException($"{label}.parts[{partIndex}].functionResponse must be an object.");
        }

        var meta = message["__meta"] as JsonObject
            ?? throw new InvalidDataException($"{label}.__meta must be an object.");
        if (meta.ContainsKey("contextBlock") || meta.ContainsKey("contextFrontierItem") || meta.ContainsKey("preservedFromBlockId"))
            throw new UnsupportedSessionAuthorityException($"{label} contains unsupported context block/frontier/preserved-message state.");
        var seq = RequiredSafeInteger(meta, "seq", $"{label}.__meta");
        if (seq != expectedSeq) throw new UnsupportedSessionAuthorityException($"{label} seq must be the contiguous value {expectedSeq}.");
        _ = RequiredFiniteNumber(meta, "timestamp", $"{label}.__meta");
    }

    private static void Validate(JsonObject root, string sessionId, string agent)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(agent);
        if (RequiredSafeInteger(root, "sessionStateVersion", "Session authority") != 1)
            throw new UnsupportedSessionAuthorityException("Only sessionStateVersion 1 is supported.");
        var history = root["history"] as JsonArray
            ?? throw new InvalidDataException("Session authority history must be an array.");
        if (root["persistentMemorySnapshot"] is not JsonValue memory || !memory.TryGetValue<string>(out _))
            throw new InvalidDataException("Session authority persistentMemorySnapshot must be a string.");
        var queue = root["queue"] as JsonArray
            ?? throw new InvalidDataException("Session authority queue must be an array.");
        if (queue.Count != 0)
            throw new UnsupportedSessionAuthorityException("Slice C1 supports only an empty queue; runtime queue persistence begins in C2.");
        var stats = root["stats"] as JsonObject
            ?? throw new InvalidDataException("Session authority stats must be an object.");
        ValidateStats(stats);
        var meta = root["meta"] as JsonObject
            ?? throw new InvalidDataException("Session authority meta must be an object.");
        _ = RequiredFiniteNumber(meta, "lastMessageTime", "Session authority meta");
        var messageCount = RequiredSafeInteger(meta, "messageCount", "Session authority meta");
        if (messageCount != history.Count) throw new InvalidDataException("Session authority meta.messageCount must equal history length.");
        if (meta.ContainsKey("lastChannel"))
            throw new UnsupportedSessionAuthorityException("Catalog-only meta.lastChannel is not supported in Session authority.");
        foreach (var unsupported in new[] { "wait", "waitLivenessFingerprints", "managedSession" })
            if (meta.ContainsKey(unsupported))
                throw new UnsupportedSessionAuthorityException($"Session authority meta.{unsupported} is unsupported.");
        if (root["busy"] is not JsonValue busy || !busy.TryGetValue<bool>(out _))
            throw new InvalidDataException("Session authority busy must be boolean.");
        if (root["stopping"] is JsonNode stoppingNode
            && (stoppingNode is not JsonValue stopping || !stopping.TryGetValue<bool>(out _)))
            throw new InvalidDataException("Session authority stopping must be boolean when present.");
        if (RequiredSafeInteger(root, "historyVersion", "Session authority") < 0)
            throw new InvalidDataException("Session authority historyVersion must be non-negative.");
        if (RequiredSafeInteger(root, "lastAppliedMailboxId", "Session authority") != 0)
            throw new UnsupportedSessionAuthorityException("Session worker mailbox state is unsupported.");
        if (root.ContainsKey("nextBlockId") && RequiredSafeInteger(root, "nextBlockId", "Session authority") != 1)
            throw new UnsupportedSessionAuthorityException("Archive block state is unsupported.");
        if (root.ContainsKey("agent"))
        {
            if (root["agent"] is not JsonValue agentValue || !agentValue.TryGetValue<string>(out var storedAgent))
                throw new InvalidDataException("Session authority agent must be a string.");
            if (storedAgent != agent) throw new UnsupportedSessionAuthorityException("Session authority agent does not match the bound agent.");
        }
        foreach (var field in new[] { "effort", "childEffortDefault" })
        {
            if (!root.ContainsKey(field)) continue;
            if (root[field] is not JsonValue effortValue || !effortValue.TryGetValue<string>(out var effort) || !ModelEfforts.Contains(effort))
                throw new InvalidDataException($"Session authority {field} is invalid.");
        }

        foreach (var unsupported in new[] { "aliases", "indexingState", "goalState", "childHandoffState", "contextFrontier" })
            if (root.ContainsKey(unsupported))
                throw new UnsupportedSessionAuthorityException($"Session authority {unsupported} is unsupported by Slice C1.");
        if (root.ContainsKey("parentSessionId"))
        {
            if (root["parentSessionId"] is not JsonValue parentValue || !parentValue.TryGetValue<string>(out var parent))
                throw new InvalidDataException("Session authority parentSessionId must be a string.");
            if (parent.Length > 0) throw new UnsupportedSessionAuthorityException("Fork/parent lineage is unsupported.");
        }

        for (var index = 0; index < history.Count; index++)
            ValidateMessage(history[index] as JsonObject
                ?? throw new InvalidDataException($"Session authority history[{index}] must be an object."), index + 1, $"history[{index}]");
        var nextMessageSeq = RequiredSafeInteger(root, "nextMessageSeq", "Session authority");
        if (nextMessageSeq != history.Count + 1)
            throw new UnsupportedSessionAuthorityException("Slice C1 requires contiguous history and nextMessageSeq == history.length + 1.");
    }

    private static string RequiredString(JsonObject value, string property, string label) =>
        value[property] is JsonValue node && node.TryGetValue<string>(out var result)
            ? result
            : throw new InvalidDataException($"{label}.{property} must be a string.");

    private static void ValidateStats(JsonObject stats)
    {
        foreach (var field in new[] { "totalCachedTokens", "totalInputTokens", "totalOutputTokens" })
            if (stats.ContainsKey(field) && stats[field] is not null)
                _ = ReadFiniteNumber(stats[field]!, $"Session authority stats.{field}");
        if (!stats.ContainsKey("lastUsage") || stats["lastUsage"] is null) return;
        var usage = stats["lastUsage"] as JsonObject
            ?? throw new InvalidDataException("Session authority stats.lastUsage must be an object or null.");
        foreach (var field in new[] { "cachedTokens", "inputTokens", "reasoningTokens", "outputTokens" })
            if (usage.ContainsKey(field) && usage[field] is not null)
                _ = ReadFiniteNumber(usage[field]!, $"Session authority stats.lastUsage.{field}");
    }

    private static long RequiredSafeInteger(JsonObject value, string property, string label)
    {
        if (value[property] is not JsonValue node || !TryReadNumber(node, out var numeric)
            || numeric < 0 || numeric > 9_007_199_254_740_991L || Math.Truncate(numeric) != numeric)
            throw new InvalidDataException($"{label}.{property} must be a non-negative safe integer.");
        return checked((long)numeric);
    }

    private static double RequiredFiniteNumber(JsonObject value, string property, string label)
    {
        if (value[property] is not JsonValue node || !TryReadNumber(node, out var result) || !double.IsFinite(result))
            throw new InvalidDataException($"{label}.{property} must be a finite number.");
        return result;
    }

    internal static double ReadFiniteNumber(JsonNode node, string label) =>
        node is JsonValue value && TryReadNumber(value, out var result) && double.IsFinite(result)
            ? result
            : throw new InvalidDataException($"{label} must be a finite number.");

    private static bool TryReadNumber(JsonValue value, out double result)
    {
        if (value.TryGetValue<double>(out result)) return true;
        if (value.TryGetValue<long>(out var signed)) { result = signed; return true; }
        if (value.TryGetValue<ulong>(out var unsigned)) { result = unsigned; return true; }
        if (value.TryGetValue<decimal>(out var decimalValue)) { result = (double)decimalValue; return true; }
        if (value.TryGetValue<float>(out var floatValue)) { result = floatValue; return true; }
        if (value.TryGetValue<int>(out var intValue)) { result = intValue; return true; }
        result = default;
        return false;
    }
}

public static class EcmaJson
{
    private static readonly JsonSerializerOptions CompactOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false
    };

    public static string Stringify(JsonNode node) =>
        RestoreJavaScriptLineSeparators(Normalize(node).ToJsonString(CompactOptions));

    private static JsonNode Normalize(JsonNode node) => node switch
    {
        JsonObject value => NormalizeObject(value),
        JsonArray value => new JsonArray(value.Select(item => item is null ? null : Normalize(item)).ToArray()),
        JsonValue value => NormalizeValue(value),
        _ => node.DeepClone()
    };

    private static JsonNode NormalizeValue(JsonValue value)
    {
        if (value.TryGetValue<JsonElement>(out var element) && element.ValueKind == JsonValueKind.Number)
        {
            var raw = element.GetRawText();
            var number = element.GetDouble();
            if (!double.IsFinite(number)) throw new InvalidDataException("Archive JSON numbers must be finite binary64 values.");
            if (raw.IndexOfAny(['.', 'e', 'E']) < 0
                && BigInteger.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var integer)
                && new BigInteger(number) != integer)
                throw new UnsupportedSessionAuthorityException($"Archive integer {raw} is not exactly representable as an ECMAScript Number.");
            return JsonNode.Parse(EcmaNumber.Format(number))!;
        }
        if (value.TryGetValue<double>(out var doubleValue)) return JsonNode.Parse(EcmaNumber.Format(doubleValue))!;
        if (value.TryGetValue<float>(out var floatValue)) return JsonNode.Parse(EcmaNumber.Format(floatValue))!;
        if (value.TryGetValue<long>(out var signed)) return NormalizeInteger(signed);
        if (value.TryGetValue<ulong>(out var unsigned)) return NormalizeInteger(unsigned);
        if (value.TryGetValue<int>(out var intValue)) return NormalizeInteger(intValue);
        if (value.TryGetValue<uint>(out var uintValue)) return NormalizeInteger(uintValue);
        if (value.TryGetValue<short>(out var shortValue)) return NormalizeInteger(shortValue);
        if (value.TryGetValue<ushort>(out var ushortValue)) return NormalizeInteger(ushortValue);
        if (value.TryGetValue<byte>(out var byteValue)) return NormalizeInteger(byteValue);
        if (value.TryGetValue<sbyte>(out var sbyteValue)) return NormalizeInteger(sbyteValue);
        if (value.TryGetValue<decimal>(out _))
            throw new UnsupportedSessionAuthorityException("CLR decimal archive values are unsupported; use an established finite binary64 Number.");
        return value.DeepClone();
    }

    private static JsonNode NormalizeInteger<T>(T value) where T : IBinaryInteger<T>
    {
        var integer = BigInteger.Parse(value.ToString(null, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);
        var number = (double)integer;
        if (!double.IsFinite(number) || new BigInteger(number) != integer)
            throw new UnsupportedSessionAuthorityException($"Archive integer {integer} is not exactly representable as an ECMAScript Number.");
        return JsonNode.Parse(EcmaNumber.Format(number))!;
    }

    private static JsonObject NormalizeObject(JsonObject value)
    {
        var result = new JsonObject();
        var properties = value.ToArray();
        foreach (var property in properties
            .Select((entry, index) => (entry, index, arrayIndex: ParseArrayIndex(entry.Key)))
            .Where(item => item.arrayIndex is not null)
            .OrderBy(item => item.arrayIndex))
            result[property.entry.Key] = property.entry.Value is null ? null : Normalize(property.entry.Value);
        foreach (var property in properties.Where(entry => ParseArrayIndex(entry.Key) is null))
            result[property.Key] = property.Value is null ? null : Normalize(property.Value);
        return result;
    }

    private static uint? ParseArrayIndex(string key)
    {
        if (key.Length == 0 || (key.Length > 1 && key[0] == '0') || !uint.TryParse(key, out var value)
            || value == uint.MaxValue || value.ToString() != key)
            return null;
        return value;
    }

    private static string RestoreJavaScriptLineSeparators(string json)
    {
        var result = new System.Text.StringBuilder(json.Length);
        for (var index = 0; index < json.Length; index++)
        {
            if (json[index] != '\\' || index + 1 >= json.Length)
            {
                result.Append(json[index]);
                continue;
            }
            if (json[index + 1] == '\\')
            {
                result.Append("\\\\");
                index++;
                continue;
            }
            if (index + 5 < json.Length && json[index + 1] == 'u')
            {
                var escape = json.AsSpan(index + 2, 4);
                if (escape.SequenceEqual("2028"))
                {
                    result.Append('\u2028');
                    index += 5;
                    continue;
                }
                if (escape.SequenceEqual("2029"))
                {
                    result.Append('\u2029');
                    index += 5;
                    continue;
                }
            }
            result.Append(json[index]);
        }
        return result.ToString();
    }
}

public static class EcmaNumber
{
    public static string Format(double value)
    {
        if (!double.IsFinite(value)) throw new InvalidDataException("ECMAScript JSON numbers must be finite.");
        if (value == 0) return "0";
        var negative = value < 0;
        var shortest = Math.Abs(value).ToString("R", CultureInfo.InvariantCulture);
        var exponentMarker = shortest.IndexOfAny(['E', 'e']);
        var significand = exponentMarker < 0 ? shortest : shortest[..exponentMarker];
        var explicitExponent = exponentMarker < 0
            ? 0
            : int.Parse(shortest[(exponentMarker + 1)..], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        var dot = significand.IndexOf('.');
        var decimalPoint = (dot < 0 ? significand.Length : dot) + explicitExponent;
        var digits = dot < 0 ? significand : significand.Remove(dot, 1);
        while (digits.Length > 1 && digits[0] == '0')
        {
            digits = digits[1..];
            decimalPoint--;
        }
        var scientificExponent = decimalPoint - 1;
        string rendered;
        if (scientificExponent >= -6 && scientificExponent < 21)
        {
            rendered = decimalPoint switch
            {
                <= 0 => "0." + new string('0', -decimalPoint) + digits,
                _ when decimalPoint >= digits.Length => digits + new string('0', decimalPoint - digits.Length),
                _ => digits.Insert(decimalPoint, ".")
            };
        }
        else
        {
            rendered = digits.Length == 1 ? digits : digits[0] + "." + digits[1..];
            rendered += scientificExponent >= 0
                ? $"e+{scientificExponent.ToString(CultureInfo.InvariantCulture)}"
                : $"e{scientificExponent.ToString(CultureInfo.InvariantCulture)}";
        }
        return negative ? "-" + rendered : rendered;
    }
}
