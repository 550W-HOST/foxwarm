using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.ToolScript;

/// <summary>Per-activity conservative materialization accounting, not an OS/process memory limit.</summary>
internal sealed class ToolScriptDataBudget(long limit = ToolScriptDataBudget.DefaultLimit)
{
    internal const long DefaultLimit = 1024L * 1024 * 1024;
    internal long Used { get; private set; }
    internal long Remaining => limit - Used;
    internal void Charge(long bytes)
    {
        if (bytes < 0 || bytes > Remaining) throw new ToolScriptDataLimitException($"ToolScript data exceeds the parent materialization budget ({(limit == DefaultLimit ? "1 GiB" : limit + " bytes")}, conservatively estimated). Return less data or use a smaller value. Completed tool effects and existing run records are retained.");
        Used += bytes;
    }
    internal void Retain(long stdoutBytes, long snapshotBytes) => Charge(checked(4 * stdoutBytes + 6 * snapshotBytes));
    internal void JsonPreflight(ReadOnlySpan<byte> bytes)
    {
        Charge(bytes.Length); JsonPreflightReserved(bytes);
    }
    private void JsonPreflightReserved(ReadOnlySpan<byte> bytes)
    {
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 256 });
        while (reader.Read()) ChargeToken(ref reader);
    }
    internal void ChargeToken(ref Utf8JsonReader reader)
    {
        // JsonDocument metadata, JsonNode/value storage, capacity growth and conversion coexistence.
        Charge(192);
        if (reader.TokenType is JsonTokenType.String or JsonTokenType.PropertyName) Charge(checked(8L * DecodedStringBytes(ref reader)));
    }
    private static long DecodedStringBytes(ref Utf8JsonReader reader)
    {
        var span = reader.ValueSpan;
        if (!reader.ValueIsEscaped) return span.Length;
        long bytes = 0;
        for (var index = 0; index < span.Length; index++)
        {
            if (span[index] != (byte)'\\') { bytes++; continue; }
            var escape = span[++index];
            if (escape != (byte)'u') { bytes++; continue; }
            var code = 0;
            for (var digit = 0; digit < 4; digit++)
            { var ch = span[++index]; code = code * 16 + (ch <= '9' ? ch - '0' : (ch | 32) - 'a' + 10); }
            // Surrogate halves conservatively charge three bytes each; no decoded string is allocated.
            bytes += code < 128 ? 1 : code < 2048 ? 2 : 3;
        }
        return bytes;
    }
    internal JsonNode? ParseJson(byte[] bytes)
    {
        JsonPreflight(bytes);
        return MaterializeJson(bytes);
    }
    private static JsonNode? MaterializeJson(ReadOnlySpan<byte> bytes)
    {
        // JsonDocument preallocates metadata proportional to payload bytes, even for one large string.
        // The completed preflight already reserves tokens, decoded text and container coexistence.
        var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { MaxDepth = 256 });
        if (!reader.Read()) throw new JsonException("ToolScript JSON is empty.");
        var value = ReadValue(ref reader);
        if (reader.Read()) throw new JsonException("Unexpected JSON tail.");
        return value;
    }
    private static JsonNode? ReadValue(ref Utf8JsonReader reader)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.StartObject:
                var obj = new JsonObject();
                while (reader.Read() && reader.TokenType != JsonTokenType.EndObject)
                { var key = reader.GetString()!; if (!reader.Read()) throw new JsonException("Incomplete JSON property."); obj[key] = ReadValue(ref reader); }
                return obj;
            case JsonTokenType.StartArray:
                var array = new JsonArray();
                while (reader.Read() && reader.TokenType != JsonTokenType.EndArray) array.Add(ReadValue(ref reader));
                return array;
            case JsonTokenType.String: return System.Text.Json.Nodes.JsonValue.Create(reader.GetString());
            case JsonTokenType.Number:
                if (reader.TryGetInt64(out var integer)) return System.Text.Json.Nodes.JsonValue.Create(integer);
                if (reader.TryGetDecimal(out var decimalValue)) return System.Text.Json.Nodes.JsonValue.Create(decimalValue);
                var number = reader.GetDouble();
                if (!double.IsFinite(number)) throw new JsonException("ToolScript JSON number is not finite.");
                return System.Text.Json.Nodes.JsonValue.Create(number);
            case JsonTokenType.True: return System.Text.Json.Nodes.JsonValue.Create(true);
            case JsonTokenType.False: return System.Text.Json.Nodes.JsonValue.Create(false);
            case JsonTokenType.Null: return null;
            default: throw new JsonException("Unsupported JSON value.");
        }
    }
    internal void JsonValue(JsonNode? value, params string[] excludedProperties)
    {
        Charge(192);
        switch (value)
        {
            case JsonObject obj:
                foreach (var (key, item) in obj) { if (excludedProperties.Contains(key, StringComparer.Ordinal)) continue; Charge(checked(8L * Encoding.UTF8.GetByteCount(key))); JsonValue(item); }
                break;
            case JsonArray array:
                foreach (var item in array) JsonValue(item);
                break;
            case JsonValue scalar when scalar.TryGetValue<string>(out var text):
                Charge(checked(8L * Encoding.UTF8.GetByteCount(text))); break;
            case JsonValue scalar when scalar.TryGetValue<JsonElement>(out var element):
                using (var writer = new Utf8JsonWriter(new ToolScriptBudgetBuffer(this))) { element.WriteTo(writer); writer.Flush(); }
                break;
        }
    }
    internal async Task<JsonObject> ReadRecordAsync(string path, CancellationToken token)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
        var length = stream.Length;
        if (length > Remaining || length > int.MaxValue) throw new ToolScriptDataLimitException("ToolScript record exceeds the parent materialization budget; the stored record has not been changed.");
        // The input buffer is charged by ParseJson. Reserve it before allocation, without charging twice.
        Charge(length); var bytes = new byte[(int)length]; await stream.ReadExactlyAsync(bytes, token);
        if (stream.ReadByte() != -1) throw new IOException("ToolScript record changed while being read.");
        JsonPreflightReserved(bytes);
        return MaterializeJson(bytes) as JsonObject ?? throw new InvalidDataException("ToolScript record must be an object.");
    }
}

internal sealed class ToolScriptDataLimitException(string message) : IOException(message);

internal sealed class ToolScriptStdout
{
    internal const long Limit = 64L * 1024 * 1024;
    private readonly List<string> chunks = [];
    private long bytes;
    internal ToolScriptStdout(string previous = "")
    {
        bytes = Encoding.UTF8.GetByteCount(previous);
        if (bytes > Limit) throw new ToolScriptDataLimitException("Stored ToolScript stdout exceeds the 64 MiB UTF-8 host output budget; the stored record has not been changed.");
        if (previous.Length > 0) chunks.Add(previous);
    }
    internal long Bytes => bytes;
    internal int Count => chunks.Count;
    internal void Append(string text)
    {
        var length = Encoding.UTF8.GetByteCount(text);
        if (length > Limit - bytes) throw new ToolScriptOutputLimitException("ToolScript stdout exceeded the 64 MiB UTF-8 cumulative host output budget. The accepted output prefix and completed tool effects are retained.");
        chunks.Add(text); bytes += length;
    }
    internal string Text() => string.Concat(chunks);
    internal string Delta(int start) => string.Concat(chunks.Skip(start));
}

internal sealed class ToolScriptOutputLimitException(string message) : IOException(message);
