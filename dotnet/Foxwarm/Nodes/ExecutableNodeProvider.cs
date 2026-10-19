using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed class NodeProviderException(string code, string message, bool retryable = false)
    : IOException(message)
{
    internal string Code { get; } = code;
    internal bool Retryable { get; } = retryable;
}

/// <summary>One request per trusted executable process. This transport never retries effects.</summary>
internal sealed partial class ExecutableNodeProvider(string id, JsonObject config)
{
    internal const string Protocol = "foxwarm-node-provider";
    private readonly string command = config["command"]!.GetValue<string>();
    private readonly string[] arguments = (config["args"] as JsonArray ?? [])
        .Select(value => value!.GetValue<string>())
        .ToArray();
    private readonly int timeoutSeconds = (int)(SessionWait.Number(config["timeoutSeconds"]) ?? 90);
    private int active;
    private readonly object descriptionGate = new();
    private Task<JsonObject>? description;
    internal string Id => id;
    private static readonly string[] EnvironmentKeys =
    [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
    ];

    internal async Task<JsonObject> DescribeAsync(CancellationToken token)
    {
        Task<JsonObject> pending;
        lock (descriptionGate)
            pending = description ??= DescribeCoreAsync(token);
        try
        {
            return (JsonObject)(await pending.WaitAsync(token)).DeepClone();
        }
        catch
        {
            lock (descriptionGate)
                if (
                    ReferenceEquals(description, pending)
                    && pending.IsCompleted
                    && !pending.IsCompletedSuccessfully
                )
                    description = null;
            throw;
        }
    }

    private async Task<JsonObject> DescribeCoreAsync(CancellationToken token)
    {
        var value = Object(await RunAsync("describe", null, token));
        Keys(
            value,
            [
                "label",
                "description",
                "lifecycle",
                "createParameters",
                "ensureParameters",
                "lifecycleDescription",
                "dataRetention",
            ]
        );
        Bounded(value["label"], 256);
        Bounded(value["description"], 4096);
        if (
            value["lifecycle"] is not JsonArray actions
            || actions.Count > 4
            || actions.Any(action =>
                SessionWait.Text(action) is not ("create" or "ensure" or "inspect" or "destroy")
            )
            || actions.Select(SessionWait.Text).Distinct().Count() != actions.Count
        )
            throw Invalid("Provider lifecycle must list unique supported operations.");
        foreach (var key in new[] { "createParameters", "ensureParameters" })
            if (value.ContainsKey(key))
            {
                BoundedJson(value[key], 16 * 1024);
            }
        foreach (var key in new[] { "lifecycleDescription", "dataRetention" })
            if (value.ContainsKey(key))
                Bounded(value[key], 4096);
        return value;
    }

    internal async Task<JsonArray> ListAsync(CancellationToken token)
    {
        var result = Object(await RunAsync("list", null, token));
        Keys(result, ["nodes"]);
        if (result["nodes"] is not JsonArray values || values.Count > 100)
            throw Invalid("Provider list must contain at most 100 Nodes.");
        var nodes = new JsonArray();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var raw in values)
        {
            var qualified = Descriptor(raw);
            if (!ids.Add(qualified["id"]!.GetValue<string>()))
                throw new NodeProviderException(
                    "NODE_PROVIDER_DUPLICATE_NODE",
                    "Provider advertises duplicate Node identities."
                );
            nodes.Add(qualified);
        }
        return nodes;
    }

    private JsonObject Descriptor(JsonNode? raw)
    {
        var node = Object(raw);
        Keys(
            node,
            ["id", "label", "kind", "type", "availability", "filesystem", "exec", "defaultCwd"]
        );
        var local = Exact(node["id"], 128, "^[A-Za-z0-9][A-Za-z0-9._:-]*$");
        if (local.Equals("master", StringComparison.OrdinalIgnoreCase))
            throw Invalid("Provider Node cannot use the reserved master identity.");
        Exact(node["type"], 64, "^[A-Za-z0-9][A-Za-z0-9._-]*$");
        if (
            SessionWait.Text(node["availability"])
                is not ("ready" or "offline" or "unavailable" or "error")
            || node.ContainsKey("kind")
                && SessionWait.Text(node["kind"]) is not ("remote" or "sandbox")
            || SessionWait.Text(node["filesystem"]) is not ("read" or "read-write")
            || node.ContainsKey("exec")
                && (
                    node["exec"] is not JsonValue flag
                    || !flag.TryGetValue<bool>(out var exec)
                    || !exec
                )
        )
            throw Invalid("Provider Node has invalid primitive support or availability.");
        if (node.ContainsKey("label"))
            Bounded(node["label"], 256);
        if (node.ContainsKey("defaultCwd"))
            Bounded(node["defaultCwd"], 4096);
        var qualified = (JsonObject)node.DeepClone();
        qualified["id"] = id + "/" + local;
        qualified["provider"] = id;
        qualified["kind"] ??= "remote";
        return qualified;
    }

    internal async Task<JsonObject> LifecycleAsync(
        string action,
        JsonObject request,
        CancellationToken token
    )
    {
        var value = Object(await RunAsync(action, request, token));
        Keys(value, ["node", "nodeId", "effect", "dataRetention", "details"]);
        var result = new JsonObject();
        if (action == "destroy")
            result["nodeId"] =
                id + "/" + Exact(value["nodeId"], 128, "^[A-Za-z0-9][A-Za-z0-9._:-]*$");
        else
            result["node"] = Descriptor(value["node"]);
        foreach (var field in new[] { "effect", "dataRetention" })
            if (value.ContainsKey(field))
                result[field] = Bounded(value[field], 4096);
        if (value.ContainsKey("details"))
        {
            BoundedJson(value["details"], 64 * 1024);
            result["details"] = value["details"]?.DeepClone();
        }
        return result;
    }

    internal static void BoundedJson(
        JsonNode? value,
        int maxBytes,
        int maxDepth = 32,
        int maxCount = 10_000,
        bool serviceBudget = false
    )
    {
        if (value is not null)
            ValidateJson(value, maxDepth, maxCount, serviceBudget);
        if (JsonBytes(value) > maxBytes)
            throw Invalid("Provider JSON exceeds its byte budget.");
    }

    // Budget the parsed data as JSON.stringify would, not the transport writer's
    // escaping or raw numeric spelling. This does not change protocol serialization.
    private static long JsonBytes(JsonNode? value) =>
        value switch
        {
            null => 4,
            JsonObject obj => 2L
                + Math.Max(0, obj.Count - 1)
                + obj.Sum(pair => JsonStringBytes(pair.Key) + 1 + JsonBytes(pair.Value)),
            JsonArray array => 2L + Math.Max(0, array.Count - 1) + array.Sum(JsonBytes),
            JsonValue scalar when scalar.TryGetValue<string>(out var text) => JsonStringBytes(text),
            JsonValue scalar when scalar.TryGetValue<bool>(out var flag) => flag ? 4 : 5,
            JsonValue scalar => EcmaNumber.Format(JsonNumber(scalar)).Length,
            _ => throw Invalid("Provider value must be plain JSON."),
        };

    private static double JsonNumber(JsonValue value) =>
        SessionWait.Number(value)
        ?? double.Parse(value.ToJsonString(), CultureInfo.InvariantCulture);

    private static long JsonStringBytes(string text)
    {
        long bytes = 2; // Quotation marks.
        for (var index = 0; index < text.Length; index++)
        {
            var character = text[index];
            if (character is '"' or '\\' or '\b' or '\f' or '\n' or '\r' or '\t')
                bytes += 2;
            else if (character < 32)
                bytes += 6;
            else if (
                char.IsHighSurrogate(character)
                && index + 1 < text.Length
                && char.IsLowSurrogate(text[index + 1])
            )
            {
                bytes += 4;
                index++;
            }
            else if (char.IsSurrogate(character))
                bytes += 6; // JSON.stringify escapes lone UTF-16 surrogates.
            else
                bytes +=
                    character <= 0x7f ? 1
                    : character <= 0x7ff ? 2
                    : 3;
        }
        return bytes;
    }

    internal async Task<JsonNode?> RunAsync(
        string operation,
        JsonObject? request,
        CancellationToken token
    )
    {
        token.ThrowIfCancellationRequested();
        if (Interlocked.Increment(ref active) > 8)
        {
            Interlocked.Decrement(ref active);
            throw new NodeProviderException(
                "NODE_PROVIDER_BACKPRESSURE",
                "Provider has too many active requests.",
                true
            );
        }
        try
        {
            var requestId = Guid.NewGuid().ToString();
            var envelope = new JsonObject
            {
                ["protocol"] = Protocol,
                ["providerId"] = id,
                ["requestId"] = requestId,
                ["operation"] = operation,
            };
            if (request is not null)
                envelope["request"] = request.DeepClone();
            ValidateJson(envelope, 32, 100_000);
            var encoded = Encoding.UTF8.GetBytes(envelope.ToJsonString());
            if (encoded.Length > 4 * 1024 * 1024)
                throw new NodeProviderException(
                    "NODE_PROVIDER_REQUEST_LIMIT",
                    "Provider request exceeds 4 MiB."
                );
            var limit =
                operation == "filesystem" ? 8 * 1024 * 1024
                : operation is "describe" or "create" or "ensure" or "inspect" or "destroy"
                    ? 512 * 1024
                : 256 * 1024;
            var raw = await RunChildAsync(
                encoded,
                limit,
                operation == "exec-poll" ? Math.Min(timeoutSeconds, 5) : timeoutSeconds,
                token
            );
            JsonObject response;
            try
            {
                response = Object(JsonNode.Parse(raw));
            }
            catch (JsonException)
            {
                throw Invalid("Provider stdout must contain exactly one JSON response.");
            }
            Keys(
                response,
                ["protocol", "providerId", "requestId", "operation", "ok", "result", "error"]
            );
            foreach (var key in new[] { "protocol", "providerId", "requestId", "operation" })
                if (SessionWait.Text(response[key]) != SessionWait.Text(envelope[key]))
                    throw new NodeProviderException(
                        "NODE_PROVIDER_"
                            + (
                                key == "protocol" ? "PROTOCOL"
                                : key == "providerId" ? "ID"
                                : key == "requestId" ? "REQUEST"
                                : "OPERATION"
                            )
                            + "_MISMATCH",
                        "Provider response identity does not match the request."
                    );
            if (response["ok"] is JsonValue ok && ok.TryGetValue<bool>(out var success))
            {
                if (success && response.ContainsKey("result") && !response.ContainsKey("error"))
                    return response["result"]?.DeepClone();
                if (
                    !success
                    && !response.ContainsKey("result")
                    && response["error"] is JsonObject error
                )
                {
                    Keys(error, ["code", "message", "retryable"]);
                    var code = Exact(error["code"], 128, "^[A-Za-z0-9][A-Za-z0-9_.:-]*$");
                    var message = SessionWait.Text(error["message"]);
                    if (
                        message is not { Length: > 0 and <= 16384 }
                        || message.Any(c => c is < ' ' and not ('\t' or '\n' or '\r') || c == 127)
                        || error.ContainsKey("retryable")
                            && (
                                error["retryable"] is not JsonValue retry
                                || !retry.TryGetValue<bool>(out _)
                            )
                    )
                        throw Invalid("Provider error is invalid.");
                    throw new NodeProviderException(
                        operation == "filesystem" ? code : "NODE_PROVIDER_REPORTED_ERROR",
                        message,
                        error["retryable"]?.GetValue<bool>() == true
                    );
                }
            }
            throw Invalid("Provider response must contain either a result or error envelope.");
        }
        finally
        {
            Interlocked.Decrement(ref active);
        }
    }

    internal static JsonObject Object(JsonNode? node) =>
        node as JsonObject ?? throw Invalid("Provider result must be an object.");

    internal static NodeProviderException Invalid(string message) =>
        new("NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE", message);

    internal static void Keys(JsonObject value, string[] allowed)
    {
        if (value.Any(pair => !allowed.Contains(pair.Key)))
            throw Invalid("Provider result contains an unsupported field.");
    }

    internal static string Bounded(JsonNode? value, int max)
    {
        var text = SessionWait.Text(value);
        if (
            text is null
            || text.Length == 0
            || text.Length > max
            || text.Any(c => c < 32 || c == 127)
        )
            throw Invalid("Provider string is invalid.");
        return text;
    }

    private static string Exact(JsonNode? value, int max, string pattern)
    {
        var text = Bounded(value, max);
        if (!Regex.IsMatch(text, pattern, RegexOptions.CultureInvariant))
            throw Invalid("Provider identity is invalid.");
        return text;
    }

    private static void ValidateJson(
        JsonNode node,
        int maxDepth,
        int maxCount,
        bool serviceBudget = false
    )
    {
        var count = 0;
        void Visit(JsonNode? item, int depth)
        {
            // The Main service budget limits container nesting; protocol/schema budgets
            // count every JSON value, including a scalar at the deepest level.
            if (
                depth > maxDepth && (!serviceBudget || item is JsonObject or JsonArray)
                || ++count > maxCount
            )
                throw Invalid("Provider JSON is too complex.");
            if (item is JsonObject obj)
            {
                if (serviceBudget && obj.Count > 2048)
                    throw Invalid("Provider JSON object has too many properties.");
                foreach (var pair in obj)
                {
                    if (serviceBudget && pair.Key.Length > 256)
                        throw Invalid("Provider JSON key is too long.");
                    Visit(pair.Value, depth + 1);
                }
            }
            else if (item is JsonArray array)
            {
                if (serviceBudget && array.Count > 2048)
                    throw Invalid("Provider JSON array has too many entries.");
                foreach (var child in array)
                    Visit(child, depth + 1);
            }
            else if (
                item is JsonValue scalar
                && !scalar.TryGetValue<string>(out _)
                && !scalar.TryGetValue<bool>(out _)
                && !double.IsFinite(JsonNumber(scalar))
            )
                throw Invalid("Provider JSON numbers must be finite.");
        }
        Visit(node, 0);
    }
}
