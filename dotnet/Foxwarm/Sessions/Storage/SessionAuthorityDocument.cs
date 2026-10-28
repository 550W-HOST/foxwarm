using System.Globalization;
using System.Numerics;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

public sealed class UnsupportedSessionAuthorityException : IOException
{
    public UnsupportedSessionAuthorityException(string message)
        : base(message) { }
}

public sealed class SessionAuthorityDocument
{
    private static readonly HashSet<string> ModelEfforts =
    [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ];
    private readonly JsonObject root;

    private SessionAuthorityDocument(JsonObject root, string sessionId, string agent)
    {
        Validate(root, sessionId, agent);
        this.root = root;
        SessionId = sessionId;
        Agent = agent;
    }

    public string SessionId { get; }
    public string Agent { get; }

    public JsonObject CloneRoot() => (JsonObject)root.DeepClone();

    public static SessionAuthorityDocument Parse(
        string json,
        string sessionId,
        string agent = "main"
    )
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            throw SessionAuthorityErrors.Invalid("Session authority is not valid JSON.");
        }
        return FromOwned(
            node as JsonObject
                ?? throw SessionAuthorityErrors.Invalid("Session authority must be a JSON object."),
            sessionId,
            agent
        );
    }

    public static SessionAuthorityDocument FromNode(
        JsonObject root,
        string sessionId,
        string agent = "main"
    ) => FromOwned((JsonObject)root.DeepClone(), sessionId, agent);

    // Transfers the complete mutable tree. The caller must not retain or expose aliases.
    internal static SessionAuthorityDocument FromOwned(
        JsonObject root,
        string sessionId,
        string agent = "main"
    ) => new(root, sessionId, agent);

    public static SessionAuthorityDocument Load(
        string filePath,
        string sessionId,
        string agent = "main"
    ) => Parse(File.ReadAllText(filePath), sessionId, agent);

    public string ToJson(bool indented = true) =>
        root.ToJsonString(
            new JsonSerializerOptions
            {
                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
                WriteIndented = indented,
            }
        );

    internal void WriteTo(Stream stream) => WriteTo(stream, root);

    // State is owned by the save attempt; history records remain immutable. Validate each
    // record with the same schema as document ingress, without retaining a mutable history tree.
    internal static void WriteTo(Stream stream, JsonObject state, SessionHistory? history = null)
    {
        using var writer = new Utf8JsonWriter(
            stream,
            new JsonWriterOptions
            {
                Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
                Indented = true,
                // Match ToJson's JsonSerializerOptions default, including unknown nested values.
                MaxDepth = 64,
            }
        );
        writer.WriteStartObject();
        foreach (var property in state)
        {
            writer.WritePropertyName(property.Key);
            if (property.Key == "history")
            {
                writer.WriteStartArray();
                if (history is not null)
                {
                    var index = 0;
                    foreach (var message in history)
                    {
                        ValidateMessage(message.ToJson(), null, $"history[{index++}]");
                        message.Data.WriteTo(writer);
                        FlushBuffer();
                    }
                }
                else
                    foreach (var message in (JsonArray)property.Value!)
                    {
                        message!.WriteTo(writer);
                        FlushBuffer();
                    }
                writer.WriteEndArray();
            }
            else if (property.Value is null)
                writer.WriteNullValue();
            else
                property.Value.WriteTo(writer);
            FlushBuffer();
        }
        writer.WriteEndObject();
        writer.Flush();

        void FlushBuffer()
        {
            // Utf8JsonWriter otherwise buffers the complete document. Flush at record/property
            // boundaries so memory is bounded by a batch or the largest individual value.
            if (writer.BytesPending >= 64 * 1024)
                writer.Flush();
        }
    }

    internal static string ValidateMessageContent(JsonObject message, string label)
    {
        var role = RequiredString(message, "role", label);
        if (role is not ("user" or "model" or "tool"))
            throw SessionAuthorityErrors.Invalid($"{label}.role is unsupported.");
        var parts =
            message["parts"] as JsonArray
            ?? throw SessionAuthorityErrors.Invalid(
                $"{label}.parts must be an array.",
                $"{label}.parts"
            );
        ValidateMessageParts(parts, $"{label}.parts");
        return role;
    }

    private static void ValidateMessageParts(JsonArray parts, string label)
    {
        foreach (var (partNode, partIndex) in parts.Select((value, index) => (value, index)))
        {
            var partLabel = $"{label}[{partIndex}]";
            var part =
                partNode as JsonObject
                ?? throw SessionAuthorityErrors.Invalid(
                    $"{partLabel} must be an object.",
                    partLabel
                );
            foreach (
                var field in new[]
                {
                    "inlineData",
                    "inlineDataRef",
                    "imageMeta",
                    "functionCall",
                    "functionResponse",
                }
            )
                if (part[field] is JsonNode value && value is not JsonObject)
                    throw SessionAuthorityErrors.Invalid(
                        $"{partLabel}.{field} must be an object.",
                        $"{partLabel}.{field}"
                    );
        }
    }

    internal static void ValidateMessage(JsonObject message, long? expectedSeq, string label)
    {
        var role = ValidateMessageContent(message, label);
        // Active Source history can predate Archive metadata. Reading or saving it does
        // not assign an identity; only newly appended Archive records require one.
        if (message["__meta"] is null && expectedSeq is null)
            return;
        var meta =
            message["__meta"] as JsonObject
            ?? throw SessionAuthorityErrors.Invalid(
                $"{label}.__meta must be an object.",
                $"{label}.__meta"
            );
        if (meta.ContainsKey("contextFrontierItem"))
            throw SessionAuthorityErrors.Unsupported(
                $"{label} contains unsupported context frontier state."
            );
        if (meta["contextBlock"] is JsonObject block)
        {
            if (expectedSeq is not null || role != "model" || meta.ContainsKey("seq"))
                throw SessionAuthorityErrors.Unsupported(
                    $"{label} context block cannot be an Archive raw message."
                );
            var id = RequiredSafeInteger(block, "id", $"{label} contextBlock");
            var level = RequiredSafeInteger(block, "level", $"{label} contextBlock");
            var start = RequiredSafeInteger(block, "sourceStart", $"{label} contextBlock");
            var end = RequiredSafeInteger(block, "sourceEnd", $"{label} contextBlock");
            var rawStart = RequiredSafeInteger(block, "rawStartSeq", $"{label} contextBlock");
            var rawEnd = RequiredSafeInteger(block, "rawEndSeq", $"{label} contextBlock");
            var kind = RequiredString(block, "sourceKind", $"{label} contextBlock");
            if (
                id == 0
                || level == 0
                || start == 0
                || end == 0
                || rawStart == 0
                || rawEnd < rawStart
                || kind is not ("message" or "block")
                || kind == "message" && (level != 1 || start != rawStart || end != rawEnd)
                || kind == "block"
                    && (
                        level <= 1
                        || (
                            block.ContainsKey("sourceBlockIds")
                                ? block["sourceBlockIds"] is not JsonArray { Count: > 0 }
                                : start > end
                        )
                    )
            )
                throw SessionAuthorityErrors.Invalid($"{label} context block shape is invalid.");
            if (
                block["sourceBlockIds"] is JsonArray ids
                && ids.Any(item =>
                    item is not JsonValue value
                    || !TryReadNumber(value, out var number)
                    || number <= 0
                    || Math.Truncate(number) != number
                )
            )
                throw SessionAuthorityErrors.Invalid($"{label} source block ids are invalid.");
        }
        else
        {
            if (meta.ContainsKey("contextBlock"))
                throw SessionAuthorityErrors.Invalid($"{label} contextBlock must be an object.");
            if (meta["seq"] is not null || expectedSeq is not null)
            {
                var seq = RequiredSafeInteger(meta, "seq", $"{label}.__meta");
                if (seq == 0 || expectedSeq is not null && seq != expectedSeq)
                    throw SessionAuthorityErrors.Invalid($"{label} seq is invalid.");
            }
            if (
                meta.ContainsKey("preservedFromBlockId")
                && RequiredSafeInteger(meta, "preservedFromBlockId", $"{label}.__meta") == 0
            )
                throw SessionAuthorityErrors.Invalid($"{label} preservedFromBlockId is invalid.");
        }
        if (meta["timestamp"] is not null || expectedSeq is not null)
            _ = RequiredFiniteNumber(meta, "timestamp", $"{label}.__meta");
    }

    internal static void Validate(JsonObject root, string sessionId, string agent)
    {
        var history =
            root["history"] as JsonArray
            ?? throw SessionAuthorityErrors.Invalid(
                "Session authority history must be an array.",
                "history"
            );
        ValidateState(root, history.Count, sessionId, agent);
        for (var index = 0; index < history.Count; index++)
            ValidateMessage(
                history[index] as JsonObject
                    ?? throw SessionAuthorityErrors.Invalid(
                        $"Session authority history[{index}] must be an object."
                    ),
                null,
                $"history[{index}]"
            );
    }

    internal static void ValidateState(
        JsonObject root,
        int historyCount,
        string sessionId,
        string agent
    )
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(agent);
        if (RequiredSafeInteger(root, "sessionStateVersion", "Session authority") != 1)
            throw SessionAuthorityErrors.Unsupported(
                "Only sessionStateVersion 1 is supported.",
                "sessionStateVersion"
            );
        if (
            root["persistentMemorySnapshot"] is not JsonValue memory
            || !memory.TryGetValue<string>(out _)
        )
            throw SessionAuthorityErrors.Invalid(
                "Session authority persistentMemorySnapshot must be a string.",
                "persistentMemorySnapshot"
            );
        var queue =
            root["queue"] as JsonArray
            ?? throw SessionAuthorityErrors.Invalid(
                "Session authority queue must be an array.",
                "queue"
            );
        ValidateQueue(queue);
        var stats =
            root["stats"] as JsonObject
            ?? throw SessionAuthorityErrors.Invalid(
                "Session authority stats must be an object.",
                "stats"
            );
        ValidateStats(stats);
        var meta =
            root["meta"] as JsonObject
            ?? throw SessionAuthorityErrors.Invalid(
                "Session authority meta must be an object.",
                "meta"
            );
        _ = RequiredFiniteNumber(meta, "lastMessageTime", "Session authority meta");
        var messageCount = RequiredSafeInteger(meta, "messageCount", "Session authority meta");
        if (messageCount != historyCount)
            throw SessionAuthorityErrors.Invalid(
                "Session authority meta.messageCount must equal history length.",
                "meta.messageCount"
            );
        if (meta.ContainsKey("lastChannel"))
            throw SessionAuthorityErrors.Unsupported(
                "Catalog-only meta.lastChannel is not supported in Session authority."
            );
        foreach (var unsupported in new[] { "managedSession" })
            if (meta.ContainsKey(unsupported))
                throw SessionAuthorityErrors.Unsupported(
                    $"Session authority meta.{unsupported} is unsupported."
                );
        if (
            meta.ContainsKey("llmFailed")
            && (meta["llmFailed"] is not JsonValue failed || !failed.TryGetValue<bool>(out _))
        )
            throw SessionAuthorityErrors.Invalid(
                "Session authority meta.llmFailed must be boolean.",
                "meta.llmFailed"
            );
        try
        {
            SessionWait.Validate(meta);
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or InvalidOperationException
                        or UnsupportedSessionTurnException
                        or FormatException
                        or NullReferenceException
            )
        {
            if (SessionAuthorityErrors.Detail(error) is not null)
                throw;
            throw SessionAuthorityErrors.Invalid("Session wait state is invalid.", "meta.wait");
        }
        if (
            root["busyStartedAt"] is JsonNode
            && (
                SessionWait.Number(root["busyStartedAt"]) is not double startedAt
                || !double.IsFinite(startedAt)
                || startedAt != Math.Truncate(startedAt)
                || startedAt < long.MinValue
                || startedAt >= (double)long.MaxValue
            )
        )
            throw SessionAuthorityErrors.Invalid(
                "Session authority busyStartedAt must be an integer.",
                "busyStartedAt"
            );
        if (root["busy"] is not JsonValue busy || !busy.TryGetValue<bool>(out _))
            throw SessionAuthorityErrors.Invalid("Session authority busy must be boolean.", "busy");
        if (
            root["stopping"] is JsonNode stoppingNode
            && (stoppingNode is not JsonValue stopping || !stopping.TryGetValue<bool>(out _))
        )
            throw SessionAuthorityErrors.Invalid(
                "Session authority stopping must be boolean when present.",
                "stopping"
            );
        if (RequiredSafeInteger(root, "historyVersion", "Session authority") < 0)
            throw SessionAuthorityErrors.Invalid(
                "Session authority historyVersion must be non-negative.",
                "historyVersion"
            );
        _ = RequiredSafeInteger(root, "lastAppliedMailboxId", "Session authority");
        if (
            root.ContainsKey("nextBlockId")
            && RequiredSafeInteger(root, "nextBlockId", "Session authority") < 1
        )
            throw SessionAuthorityErrors.Invalid(
                "Session authority nextBlockId must be positive.",
                "nextBlockId"
            );
        if (root.ContainsKey("agent"))
        {
            if (
                root["agent"] is not JsonValue agentValue
                || !agentValue.TryGetValue<string>(out var storedAgent)
            )
                throw SessionAuthorityErrors.Invalid(
                    "Session authority agent must be a string.",
                    "agent"
                );
            if (storedAgent != agent)
                throw SessionAuthorityErrors.Unsupported(
                    "Session authority agent does not match the bound agent.",
                    "agent"
                );
        }
        else if (agent != "main")
            throw SessionAuthorityErrors.Invalid(
                "Named Agent Session authority requires an explicit agent binding."
            );
        foreach (var field in new[] { "effort", "childEffortDefault" })
        {
            if (!root.ContainsKey(field))
                continue;
            if (
                root[field] is not JsonValue effortValue
                || !effortValue.TryGetValue<string>(out var effort)
                || !ModelEfforts.Contains(effort)
            )
                throw SessionAuthorityErrors.Invalid($"Session authority {field} is invalid.");
        }

        if (
            root.ContainsKey("aliases")
            && (
                root["aliases"] is not JsonArray aliases
                || aliases.Any(node => SessionWait.Text(node) is not { Length: > 0 })
            )
        )
            throw SessionAuthorityErrors.Invalid(
                "Session authority aliases must be nonempty strings.",
                "aliases"
            );
        if (root["childHandoffState"] is JsonObject handoff)
        {
            var boundary = RequiredString(
                handoff,
                "boundary",
                "Session authority childHandoffState"
            );
            if (boundary is not ("direct-user" or "report-required"))
                throw SessionAuthorityErrors.Invalid(
                    "Session authority childHandoffState.boundary is invalid.",
                    "childHandoffState.boundary"
                );
            if (handoff["resolved"] is not JsonValue resolved || !resolved.TryGetValue<bool>(out _))
                throw SessionAuthorityErrors.Invalid(
                    "Session authority childHandoffState.resolved must be boolean.",
                    "childHandoffState.resolved"
                );
        }
        else if (root.ContainsKey("childHandoffState"))
            throw SessionAuthorityErrors.Invalid(
                "Session authority childHandoffState must be an object.",
                "childHandoffState"
            );
        foreach (var unsupported in new[] { "indexingState", "contextFrontier" })
            if (root.ContainsKey(unsupported))
                throw SessionAuthorityErrors.Unsupported(
                    $"Session authority {unsupported} is unsupported.",
                    unsupported
                );
        if (root.ContainsKey("parentSessionId"))
        {
            if (
                root["parentSessionId"] is not JsonValue parentValue
                || !parentValue.TryGetValue<string>(out var parent)
            )
                throw SessionAuthorityErrors.Invalid(
                    "Session authority parentSessionId must be a string.",
                    "parentSessionId"
                );
        }

        var nextMessageSeq = RequiredSafeInteger(root, "nextMessageSeq", "Session authority");
        if (nextMessageSeq < 1)
            throw SessionAuthorityErrors.Invalid(
                "Session authority nextMessageSeq must be positive.",
                "nextMessageSeq"
            );
    }

    private static string RequiredString(JsonObject value, string property, string label) =>
        value[property] is JsonValue node && node.TryGetValue<string>(out var result)
            ? result
            : throw SessionAuthorityErrors.Invalid(
                $"{label}.{property} must be a string.",
                $"{label}.{property}"
            );

    private static void ValidateStats(JsonObject stats)
    {
        foreach (
            var field in new[] { "totalCachedTokens", "totalInputTokens", "totalOutputTokens" }
        )
            if (stats.ContainsKey(field))
                _ = ReadFiniteNumber(
                    stats[field]
                        ?? throw SessionAuthorityErrors.Invalid(
                            "Session authority stats numbers cannot be null.",
                            "stats"
                        ),
                    $"Session authority stats.{field}"
                );
        ValidateCost(stats, "totalCost");
        if (!stats.ContainsKey("lastUsage") || stats["lastUsage"] is null)
            return;
        var usage =
            stats["lastUsage"] as JsonObject
            ?? throw SessionAuthorityErrors.Invalid(
                "Session authority stats.lastUsage must be an object or null.",
                "stats.lastUsage"
            );
        foreach (
            var field in new[] { "cachedTokens", "inputTokens", "reasoningTokens", "outputTokens" }
        )
            if (usage.ContainsKey(field))
                _ = ReadFiniteNumber(
                    usage[field]
                        ?? throw SessionAuthorityErrors.Invalid(
                            "Session authority usage numbers cannot be null.",
                            "usage"
                        ),
                    $"Session authority stats.lastUsage.{field}"
                );
        ValidateCost(usage, "cost");
    }

    private static void ValidateCost(JsonObject value, string field)
    {
        if (!value.ContainsKey(field))
            return;
        if (value[field] is null || ReadFiniteNumber(value[field]!, field) < 0)
            throw SessionAuthorityErrors.Invalid(field + " must be a finite nonnegative number.");
    }

    private static void ValidateQueue(JsonArray queue)
    {
        var ordinaryTypes = new HashSet<string>(
            ["user", "intersession", "background", "trigger", "onboot"],
            StringComparer.Ordinal
        );
        for (var index = 0; index < queue.Count; index++)
        {
            var item =
                queue[index] as JsonObject
                ?? throw SessionAuthorityErrors.Invalid(
                    $"Session authority queue[{index}] must be an object."
                );
            var type = RequiredString(item, "type", $"queue[{index}]");
            if (type == "compact-commit")
                continue;
            if (!ordinaryTypes.Contains(type))
                throw SessionAuthorityErrors.Unsupported(
                    $"Session authority queue[{index}].type is unsupported.",
                    $"queue[{index}].type"
                );
            var hasParts = item["parts"] is JsonArray parts && parts.Count > 0;
            if (item.ContainsKey("parts") && item["parts"] is not JsonArray)
                throw SessionAuthorityErrors.Invalid(
                    $"Session authority queue[{index}].parts must be an array."
                );
            if (item["parts"] is JsonArray itemParts)
                ValidateMessageParts(itemParts, $"queue[{index}].parts");
            var hasMessage = item["message"] is JsonObject;
            if (item.ContainsKey("message") && item["message"] is not JsonObject)
                throw SessionAuthorityErrors.Invalid(
                    $"Session authority queue[{index}].message must be an object."
                );
            if (item["message"] is JsonObject message)
                ValidateMessageContent(message, $"queue[{index}].message");
            if (!hasParts && !hasMessage)
                throw SessionAuthorityErrors.Invalid(
                    $"Session authority queue[{index}] must contain nonempty parts or a message."
                );
            if (item.ContainsKey("source"))
            {
                var source =
                    item["source"] as JsonObject
                    ?? throw SessionAuthorityErrors.Invalid(
                        $"Session authority queue[{index}].source must be an object."
                    );
                _ = RequiredString(source, "platform", $"queue[{index}].source");
                _ = RequiredString(source, "channelUserId", $"queue[{index}].source");
                foreach (
                    var field in new[]
                    {
                        "channelId",
                        "channelType",
                        "conversationId",
                        "username",
                        "senderId",
                    }
                )
                    if (
                        source.ContainsKey(field)
                        && (
                            source[field] is not JsonValue value
                            || !value.TryGetValue<string>(out _)
                        )
                    )
                        throw SessionAuthorityErrors.Invalid(
                            $"Session authority queue[{index}].source.{field} must be a string."
                        );
            }
            foreach (var field in new[] { "clientMessageId", "sourceSessionId" })
                if (
                    item.ContainsKey(field)
                    && (item[field] is not JsonValue value || !value.TryGetValue<string>(out _))
                )
                    throw SessionAuthorityErrors.Invalid(
                        $"Session authority queue[{index}].{field} must be a string."
                    );
            if (item.ContainsKey("sourceSessionRelation"))
            {
                var relation = RequiredString(item, "sourceSessionRelation", $"queue[{index}]");
                if (relation is not ("direct-child" or "parent" or "other"))
                    throw SessionAuthorityErrors.Invalid(
                        $"Session authority queue[{index}].sourceSessionRelation is invalid."
                    );
            }
        }
    }

    private static long RequiredSafeInteger(JsonObject value, string property, string label)
    {
        if (
            value[property] is not JsonValue node
            || !TryReadNumber(node, out var numeric)
            || numeric < 0
            || numeric > 9_007_199_254_740_991L
            || Math.Truncate(numeric) != numeric
        )
            throw SessionAuthorityErrors.Invalid(
                $"{label}.{property} must be a non-negative safe integer.",
                label == "Session authority" ? property : $"{label}.{property}"
            );
        return checked((long)numeric);
    }

    private static double RequiredFiniteNumber(JsonObject value, string property, string label)
    {
        if (
            value[property] is not JsonValue node
            || !TryReadNumber(node, out var result)
            || !double.IsFinite(result)
        )
            throw SessionAuthorityErrors.Invalid(
                $"{label}.{property} must be a finite number.",
                $"{label}.{property}"
            );
        return result;
    }

    internal static double ReadFiniteNumber(JsonNode node, string label) =>
        node is JsonValue value && TryReadNumber(value, out var result) && double.IsFinite(result)
            ? result
            : throw SessionAuthorityErrors.Invalid($"{label} must be a finite number.");

    private static bool TryReadNumber(JsonValue value, out double result)
    {
        if (value.TryGetValue<double>(out result))
            return true;
        if (value.TryGetValue<long>(out var signed))
        {
            result = signed;
            return true;
        }
        if (value.TryGetValue<ulong>(out var unsigned))
        {
            result = unsigned;
            return true;
        }
        if (value.TryGetValue<decimal>(out var decimalValue))
        {
            result = (double)decimalValue;
            return true;
        }
        if (value.TryGetValue<float>(out var floatValue))
        {
            result = floatValue;
            return true;
        }
        if (value.TryGetValue<int>(out var intValue))
        {
            result = intValue;
            return true;
        }
        result = default;
        return false;
    }
}

public static class EcmaJson
{
    private static readonly JsonSerializerOptions CompactOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    public static string Stringify(JsonNode node) =>
        RestoreJavaScriptLineSeparators(Normalize(node).ToJsonString(CompactOptions));

    private static JsonNode Normalize(JsonNode node) =>
        node switch
        {
            JsonObject value => NormalizeObject(value),
            JsonArray value => new JsonArray(
                value.Select(item => item is null ? null : Normalize(item)).ToArray()
            ),
            JsonValue value => NormalizeValue(value),
            _ => node.DeepClone(),
        };

    private static JsonNode NormalizeValue(JsonValue value)
    {
        if (
            value.TryGetValue<JsonElement>(out var element)
            && element.ValueKind == JsonValueKind.Number
        )
        {
            var raw = element.GetRawText();
            var number = element.GetDouble();
            if (!double.IsFinite(number))
                throw new InvalidDataException(
                    "Archive JSON numbers must be finite binary64 values."
                );
            if (
                raw.IndexOfAny(['.', 'e', 'E']) < 0
                && BigInteger.TryParse(
                    raw,
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out var integer
                )
                && new BigInteger(number) != integer
            )
                throw new UnsupportedSessionAuthorityException(
                    $"Archive integer {raw} is not exactly representable as an ECMAScript Number."
                );
            return JsonNode.Parse(EcmaNumber.Format(number))!;
        }
        if (value.TryGetValue<double>(out var doubleValue))
            return JsonNode.Parse(EcmaNumber.Format(doubleValue))!;
        if (value.TryGetValue<float>(out var floatValue))
            return JsonNode.Parse(EcmaNumber.Format(floatValue))!;
        if (value.TryGetValue<long>(out var signed))
            return NormalizeInteger(signed);
        if (value.TryGetValue<ulong>(out var unsigned))
            return NormalizeInteger(unsigned);
        if (value.TryGetValue<int>(out var intValue))
            return NormalizeInteger(intValue);
        if (value.TryGetValue<uint>(out var uintValue))
            return NormalizeInteger(uintValue);
        if (value.TryGetValue<short>(out var shortValue))
            return NormalizeInteger(shortValue);
        if (value.TryGetValue<ushort>(out var ushortValue))
            return NormalizeInteger(ushortValue);
        if (value.TryGetValue<byte>(out var byteValue))
            return NormalizeInteger(byteValue);
        if (value.TryGetValue<sbyte>(out var sbyteValue))
            return NormalizeInteger(sbyteValue);
        if (value.TryGetValue<decimal>(out _))
            throw new UnsupportedSessionAuthorityException(
                "CLR decimal archive values are unsupported; use an established finite binary64 Number."
            );
        return value.DeepClone();
    }

    private static JsonNode NormalizeInteger<T>(T value)
        where T : IBinaryInteger<T>
    {
        var integer = BigInteger.Parse(
            value.ToString(null, CultureInfo.InvariantCulture),
            CultureInfo.InvariantCulture
        );
        var number = (double)integer;
        if (!double.IsFinite(number) || new BigInteger(number) != integer)
            throw new UnsupportedSessionAuthorityException(
                $"Archive integer {integer} is not exactly representable as an ECMAScript Number."
            );
        return JsonNode.Parse(EcmaNumber.Format(number))!;
    }

    private static JsonObject NormalizeObject(JsonObject value)
    {
        var result = new JsonObject();
        var properties = value.ToArray();
        foreach (
            var property in properties
                .Select((entry, index) => (entry, index, arrayIndex: ParseArrayIndex(entry.Key)))
                .Where(item => item.arrayIndex is not null)
                .OrderBy(item => item.arrayIndex)
        )
            result[property.entry.Key] = property.entry.Value is null
                ? null
                : Normalize(property.entry.Value);
        foreach (var property in properties.Where(entry => ParseArrayIndex(entry.Key) is null))
            result[property.Key] = property.Value is null ? null : Normalize(property.Value);
        return result;
    }

    private static uint? ParseArrayIndex(string key)
    {
        if (
            key.Length == 0
            || (key.Length > 1 && key[0] == '0')
            || !uint.TryParse(key, out var value)
            || value == uint.MaxValue
            || value.ToString() != key
        )
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
