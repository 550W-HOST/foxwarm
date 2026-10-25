using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// Best-effort wire diagnostics, never a request/history authority. Writes are
// awaited by their producers; there is no background payload queue or shutdown owner.
internal sealed class ModelInteractionDiagnostics(string dataRoot)
{
    private readonly string logs = Path.Combine(dataRoot, "state", "logs");
    private readonly SemaphoreSlim writes = new(1, 1);

    internal Interaction Begin(int iteration = 0) => new(this, iteration);

    private async Task WriteAsync(string path, JsonNode value)
    {
        await writes.WaitAsync().ConfigureAwait(false);
        try
        {
            var recent = Path.Combine(logs, "recent");
            Directory.CreateDirectory(recent);
            var files = new DirectoryInfo(recent)
                .GetFiles()
                .OrderBy(file => file.LastWriteTimeUtc)
                .ToList();
            // Source prunes before creating/updating each file. Failed cleanup
            // remains best effort and cannot change a provider outcome.
            while (files.Count >= 20)
            {
                var oldest = files[0];
                files.RemoveAt(0);
                try
                {
                    oldest.Delete();
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            await using var file = new FileStream(
                path,
                FileMode.Create,
                FileAccess.Write,
                FileShare.Read,
                4096,
                FileOptions.Asynchronous
            );
            await JsonSerializer
                .SerializeAsync(file, value, new JsonSerializerOptions { WriteIndented = true })
                .ConfigureAwait(false);
        }
        finally
        {
            writes.Release();
        }
    }

    internal sealed class Interaction
    {
        private readonly ModelInteractionDiagnostics owner;
        private readonly string requestPath;
        private readonly string responsePath;
        private readonly JsonArray failures = [];
        private readonly JsonArray selections = [];
        private bool requestWritten;

        internal Interaction(ModelInteractionDiagnostics owner, int iteration)
        {
            this.owner = owner;
            // Concurrent requests can start within one millisecond.
            var name =
                DateTime.Now.ToString(
                    "HHmmssfff",
                    System.Globalization.CultureInfo.InvariantCulture
                )
                + "_iter"
                + iteration
                + "_"
                + Guid.NewGuid().ToString("N");
            requestPath = Path.Combine(owner.logs, "recent", name + "_req.json");
            responsePath = Path.Combine(owner.logs, "recent", name + "_res.json");
        }

        internal Attempt StartAttempt(
            ConcreteHostModel model,
            ResponsesClientOptions options,
            int number,
            string? virtualModel = null
        ) => new(this, model, options, number, virtualModel);

        private async Task PreparedAsync(Attempt attempt, JsonNode payload)
        {
            selections.Add(
                new JsonObject { ["attempt"] = attempt.Number, ["modelId"] = attempt.ModelId }
            );
            if (requestWritten && attempt.VirtualModel is null)
                return;
            var body = attempt.Redact(payload);
            var request = attempt.VirtualModel is null
                ? body
                : new JsonObject
                {
                    ["virtualModelKey"] = attempt.VirtualModel,
                    ["selections"] = selections.DeepClone(),
                    ["selectedModelId"] = attempt.ModelId,
                    ["request"] = body,
                };
            try
            {
                await owner.WriteAsync(requestPath, request!).ConfigureAwait(false);
                requestWritten = true;
            }
            catch
            {
                Warn();
            }
        }

        private async Task FinishedAsync(Attempt attempt, Exception? error)
        {
            if (!requestWritten)
                return;
            var current = attempt.Snapshot();
            JsonObject result;
            if (error is not null)
            {
                current["attempt"] = attempt.Number;
                current["modelId"] = attempt.ModelId;
                current["error"] = attempt.ErrorText(error.Message);
                current["name"] = error.GetType().Name;
                if (attempt.VirtualModel is not null)
                    current["virtualModelKey"] = attempt.VirtualModel;
                failures.Add(current);
                result = new JsonObject { ["attempts"] = failures.DeepClone() };
            }
            else
            {
                result = current;
                if (failures.Count > 0)
                    result["attempts"] = failures.DeepClone();
            }
            try
            {
                await owner.WriteAsync(responsePath, result).ConfigureAwait(false);
            }
            catch
            {
                Warn();
            }
        }

        internal async Task MoveToErrorAsync()
        {
            if (!requestWritten)
                return;
            await owner.writes.WaitAsync().ConfigureAwait(false);
            try
            {
                var directory = Path.Combine(
                    owner.logs,
                    DateTime.Now.ToString(
                        "yyyy-MM-dd",
                        System.Globalization.CultureInfo.InvariantCulture
                    ) + "-error"
                );
                Directory.CreateDirectory(directory);
                foreach (var path in new[] { requestPath, responsePath })
                    if (File.Exists(path))
                        File.Move(
                            path,
                            Path.Combine(directory, Path.GetFileName(path)),
                            overwrite: true
                        );
            }
            catch
            {
                Warn();
            }
            finally
            {
                owner.writes.Release();
            }
        }

        internal sealed class Attempt
        {
            private readonly Interaction interaction;
            private readonly string[] secrets;
            private readonly RawCapture raw;
            private readonly object rawGate = new();
            private JsonObject response = new();
            private bool responseBodyTruncated;
            internal string ModelId { get; }
            internal string? VirtualModel { get; }
            internal int Number { get; }

            internal Attempt(
                Interaction interaction,
                ConcreteHostModel model,
                ResponsesClientOptions options,
                int number,
                string? virtualModel
            )
            {
                this.interaction = interaction;
                Number = number;
                // Keep the exact attempt's credentials even if live configuration
                // changes while its stream or diagnostic write is still outstanding.
                secrets = new[] { options.Token }
                    .Concat(
                        (options.ExtraHeaders ?? new JsonObject()).Select(pair =>
                            SessionWait.Text(pair.Value) ?? ""
                        )
                    )
                    .Where(value => value.Length > 0)
                    .Distinct(StringComparer.Ordinal)
                    .SelectMany(value => new[] { value, JsonSerializer.Serialize(value)[1..^1] })
                    .Distinct(StringComparer.Ordinal)
                    .OrderByDescending(value => value.Length)
                    .ToArray();
                ModelId = SafeText(model.Key);
                VirtualModel = virtualModel is null ? null : SafeText(virtualModel);
                raw = new RawCapture(
                    model.ProviderType is "openai" or "openai-responses" or "openai-ws"
                        && model.Configuration["imageGeneration"]?["enabled"]?.GetValue<bool>()
                            == true
                );
            }

            private static async Task BestEffortAsync(Func<Task> operation)
            {
                try
                {
                    await operation().ConfigureAwait(false);
                }
                catch
                {
                    Warn();
                }
            }

            internal Task PreparedAsync(JsonNode payload) =>
                BestEffortAsync(() =>
                {
                    // The serializer has now prepared the actual native replay input.
                    if (
                        (payload["input"] as JsonArray)
                            ?.OfType<JsonObject>()
                            .Any(HostedResponsesTools.IsGeneratedImage) == true
                    )
                        lock (rawGate)
                            raw.OmitContent();
                    return interaction.PreparedAsync(this, payload);
                });

            internal Task FinishedAsync(Exception? error) =>
                BestEffortAsync(() => interaction.FinishedAsync(this, error));

            internal void Chunk(string text)
            {
                try
                {
                    lock (rawGate)
                        raw.Chunk(text);
                }
                catch
                {
                    Warn();
                }
            }

            internal void Block(string text)
            {
                try
                {
                    lock (rawGate)
                        raw.Block(text);
                }
                catch
                {
                    Warn();
                }
            }

            internal void Response(
                string status,
                JsonObject headers,
                JsonNode? body,
                bool truncated = false
            )
            {
                try
                {
                    response = new JsonObject
                    {
                        ["status"] = SafeText(status),
                        ["headers"] = Redact(headers),
                        ["body"] = RedactBody(body, truncated),
                    };
                }
                catch
                {
                    Warn();
                }
            }

            private JsonNode? RedactBody(JsonNode? body, bool truncated)
            {
                responseBodyTruncated = truncated;
                return truncated && SessionWait.Text(body) is string text
                    ? JsonValue.Create(SafeText(TrimCredentialSuffix(text)))
                    : Redact(body);
            }

            // A provider may also expose its bounded response body as the error
            // message. Carry the same cutoff protection into that projection.
            internal string ErrorText(string text) =>
                SafeText(responseBodyTruncated ? TrimCredentialSuffix(text) : text);

            internal void ResponseBody(JsonNode? body, bool truncated = false)
            {
                try
                {
                    var next = (JsonObject)response.DeepClone();
                    next["body"] = RedactBody(body, truncated);
                    response = next;
                }
                catch
                {
                    Warn();
                }
            }

            internal JsonObject Snapshot()
            {
                var result = (JsonObject)response.DeepClone();
                JsonObject? snapshot;
                lock (rawGate)
                    snapshot = raw.HasChunks ? raw.Snapshot() : null;
                if (snapshot is not null)
                {
                    if (snapshot["truncated"]?.GetValue<bool>() == true)
                    {
                        if (SessionWait.Text(snapshot["body"]) is string body)
                            snapshot["body"] = TrimCredentialSuffix(body);
                        if (snapshot["sseBlocks"] is JsonArray blocks && blocks.Count > 0)
                            blocks[^1] = TrimCredentialSuffix(SessionWait.Text(blocks[^1]) ?? "");
                    }
                    result["rawStream"] = Redact(snapshot);
                }
                return result;
            }

            private string TrimCredentialSuffix(string text)
            {
                var open = -1;
                var escaped = false;
                for (var index = 0; index < text.Length; index++)
                {
                    if (open < 0)
                    {
                        if (text[index] == '"')
                            open = index;
                    }
                    else if (escaped)
                        escaped = false;
                    else if (text[index] == '\\')
                        escaped = true;
                    else if (text[index] == '"')
                        open = -1;
                }
                // The cutoff may bisect an escaped credential. An incomplete
                // JSON literal cannot be safely decoded for redaction.
                if (open >= 0)
                    text = text[..open] + "\"[truncated JSON string omitted]\"";
                return TrimSecretPrefix(text);
            }

            private string TrimSecretPrefix(string text)
            {
                foreach (var secret in secrets)
                    for (
                        var length = Math.Min(secret.Length - 1, text.Length);
                        length > 0;
                        length--
                    )
                        if (text.EndsWith(secret[..length], StringComparison.Ordinal))
                        {
                            text = text[..^length] + "[redacted]";
                            break;
                        }
                return text;
            }

            internal string SafeText(string text)
            {
                // Scan quoted lexemes, including an interrupted final literal or
                // one terminated by an illegal raw newline in malformed SSE.
                // Preserve unrelated spelling; only sensitive literals change.
                var result = new StringBuilder();
                var copied = 0;
                for (var start = 0; start < text.Length; start++)
                {
                    if (text[start] != '"')
                        continue;
                    var end = start + 1;
                    var escaped = false;
                    var closed = false;
                    for (; end < text.Length && text[end] is not ('\r' or '\n'); end++)
                    {
                        if (escaped)
                            escaped = false;
                        else if (text[end] == '\\')
                            escaped = true;
                        else if (text[end] == '"')
                        {
                            closed = true;
                            end++;
                            break;
                        }
                    }
                    var literal = text[start..end];
                    string? decoded = null;
                    try
                    {
                        decoded = JsonSerializer.Deserialize<string>(
                            closed ? literal : literal + "\""
                        );
                    }
                    catch (JsonException) { }
                    string? replacement = null;
                    if (decoded is not null)
                    {
                        var safe = ReplaceSecrets(closed ? decoded : TrimSecretPrefix(decoded));
                        if (safe != decoded)
                            replacement = JsonSerializer.Serialize(safe);
                    }
                    // An interrupted escape cannot be decoded safely. Omit
                    // only that literal, retaining the surrounding evidence.
                    else if (secrets.Length > 0 && literal.Contains('\\'))
                        replacement = "\"[malformed escaped string omitted]\"";
                    if (replacement is not null)
                    {
                        result.Append(text.AsSpan(copied, start - copied));
                        result.Append(replacement);
                        copied = end;
                    }
                    start = end - 1;
                }
                result.Append(text.AsSpan(copied));
                return ReplaceSecrets(result.ToString());
            }

            private string ReplaceSecrets(string text)
            {
                foreach (var secret in secrets)
                    text = text.Replace(secret, "[redacted]", StringComparison.Ordinal);
                return Regex.Replace(
                    text,
                    @"data:image/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]*",
                    "data:image/omitted;base64,[image omitted from diagnostics]"
                );
            }

            internal JsonNode? Redact(JsonNode? node)
            {
                if (node is JsonValue value && value.TryGetValue<string>(out var text))
                {
                    if (
                        text.Contains("b64_json", StringComparison.Ordinal)
                        || text.Contains("partial_image_b64", StringComparison.Ordinal)
                        || text.Contains("image_generation_call", StringComparison.Ordinal)
                        || text.Contains("base64", StringComparison.Ordinal)
                    )
                        try
                        {
                            var structured = JsonNode.Parse(text);
                            if (structured is JsonObject or JsonArray)
                                return JsonValue.Create(Redact(structured)!.ToJsonString());
                        }
                        catch (JsonException) { }
                    return JsonValue.Create(SafeText(text));
                }
                if (node is JsonArray array)
                    return new JsonArray(array.Select(Redact).ToArray());
                if (node is not JsonObject obj)
                    return node?.DeepClone();
                var result = new JsonObject();
                foreach (var (key, child) in obj)
                    result[SafeText(key)] =
                        child is JsonValue scalar
                        && scalar.TryGetValue<string>(out var data)
                        && data.Length > 0
                        && (
                            key is "partial_image_b64" or "b64_json"
                            || key == "result"
                                && SessionWait.Text(obj["type"]) == "image_generation_call"
                            || key == "data"
                                && SessionWait.Text(obj["type"]) == "base64"
                                && SessionWait
                                    .Text(obj["media_type"])
                                    ?.StartsWith("image/", StringComparison.Ordinal) == true
                        )
                            ? JsonValue.Create("[image omitted from diagnostics]")
                            : Redact(child);
                return result;
            }
        }
    }

    private static void Warn() =>
        System.Diagnostics.Trace.TraceWarning(
            "Model interaction diagnostics could not be written."
        );

    private sealed class RawCapture(bool imageDeclared)
    {
        internal const int MaxChars = 5 * 1024 * 1024;
        private readonly StringBuilder body = new();
        private readonly List<string> blocks = [];
        private readonly SortedDictionary<string, long> eventTypes = new(StringComparer.Ordinal);
        private int blockChars;
        private bool omitted = imageDeclared;
        private bool truncated;
        private long chunkCount,
            chunkChars,
            blockCount,
            nonJsonBlocks;
        internal bool HasChunks => chunkCount > 0 || blockCount > 0;

        internal void Chunk(string text)
        {
            if (text.Length == 0)
                return;
            chunkCount++;
            chunkChars += text.Length;
            if (omitted)
                return;
            var count = Math.Min(text.Length, MaxChars - body.Length);
            body.Append(text.AsSpan(0, count));
            truncated |= count < text.Length;
        }

        internal void OmitContent()
        {
            omitted = true;
            body.Clear();
            blocks.Clear();
        }

        private static bool HasImageOutput(string text)
        {
            // Retain conservative detection for malformed event-type literals.
            if (text.Contains("image_generation_call", StringComparison.Ordinal))
                return true;
            foreach (Match match in Regex.Matches(text, "\"(?:\\\\.|[^\"\\\\])*\""))
                try
                {
                    var value = JsonSerializer.Deserialize<string>(match.Value);
                    if (
                        value is "b64_json" or "partial_image_b64"
                        || value?.Contains("image_generation_call", StringComparison.Ordinal)
                            == true
                    )
                        return true;
                }
                catch (JsonException) { }
            return false;
        }

        internal void Block(string block)
        {
            if (block.Length == 0)
                return;
            blockCount++;
            // Unsolicited hosted image output must not leak through the raw lane.
            if (HasImageOutput(block))
                OmitContent();
            foreach (var line in block.Replace("\r", "", StringComparison.Ordinal).Split('\n'))
            {
                var payload = line.StartsWith("data:", StringComparison.Ordinal)
                    ? line[5..].Trim()
                    : line.Trim();
                if (payload.Length == 0 || payload == "[DONE]")
                    continue;
                try
                {
                    var type = SessionWait.Text(JsonNode.Parse(payload)?["type"]) ?? "unknown";
                    type = type.Length > 80 ? type[..80] : type;
                    if (!eventTypes.ContainsKey(type) && eventTypes.Count >= 1024)
                        type = "other";
                    eventTypes[type] = eventTypes.GetValueOrDefault(type) + 1;
                }
                catch (JsonException)
                {
                    nonJsonBlocks++;
                }
                catch (InvalidOperationException)
                {
                    nonJsonBlocks++;
                }
            }
            if (omitted)
                return;
            var count = Math.Min(block.Length, MaxChars - blockChars);
            if (count > 0)
                blocks.Add(block[..count]);
            blockChars += count;
            truncated |= count < block.Length;
        }

        internal JsonObject Snapshot()
        {
            // A stream can end before its first SSE delimiter. Inspect the
            // bounded captured content, not only completed block callbacks.
            if (!omitted && HasImageOutput(body.ToString()))
                OmitContent();
            return omitted
                ? new JsonObject
                {
                    ["format"] = "sse-diagnostics",
                    ["hostedImageGeneration"] = true,
                    ["contentOmitted"] = true,
                    ["chunkCount"] = chunkCount,
                    ["chunkCharCount"] = chunkChars,
                    ["sseBlockCount"] = blockCount,
                    ["nonJsonBlockCount"] = nonJsonBlocks,
                    ["eventTypes"] = new JsonObject(
                        eventTypes.Select(pair =>
                            KeyValuePair.Create<string, JsonNode?>(
                                pair.Key,
                                JsonValue.Create(pair.Value)
                            )
                        )
                    ),
                }
                : new JsonObject
                {
                    ["format"] = "sse",
                    ["body"] = body.ToString(),
                    ["sseBlocks"] = new JsonArray(
                        blocks.Select(block => (JsonNode?)JsonValue.Create(block)).ToArray()
                    ),
                    ["truncated"] = truncated,
                    ["maxChars"] = MaxChars,
                };
        }
    }
}

internal sealed class DiagnosticChatService(
    IChatService inner,
    ModelInteractionDiagnostics.Interaction.Attempt diagnostics
) : IChatService
{
    public async Task<ChatResult> ChatAsync(
        string sessionId,
        IReadOnlyList<JsonObject> history,
        CancellationToken token
    )
    {
        try
        {
            var result = await inner.ChatAsync(sessionId, history, token).ConfigureAwait(false);
            await diagnostics.FinishedAsync(null).ConfigureAwait(false);
            return result;
        }
        catch (Exception error)
        {
            await diagnostics.FinishedAsync(error).ConfigureAwait(false);
            throw;
        }
    }
}
