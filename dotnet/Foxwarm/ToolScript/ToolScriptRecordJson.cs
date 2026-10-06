using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.ToolScript;

/// <summary>Source-shaped JSON using standard segmented string escaping and bounded flushes.</summary>
internal static class ToolScriptRecordJson
{
    internal const int ScratchReservation = 1024 * 1024;
    private const int StringChunk = 16384;

    internal static void Write(Stream stream, JsonNode? value, ToolScriptDataBudget budget)
    {
        using var writer = new Utf8JsonWriter(stream);
        WriteValue(writer, value, budget);
        writer.Flush();
    }

    private static void WriteValue(
        Utf8JsonWriter writer,
        JsonNode? value,
        ToolScriptDataBudget budget
    )
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case JsonObject obj:
                writer.WriteStartObject();
                foreach (var (key, item) in obj)
                {
                    // Property names have no segmented API. Reserve their worst encoding/coexistence before encoding.
                    budget.Charge(16L * Encoding.UTF8.GetByteCount(key));
                    writer.WritePropertyName(key);
                    WriteValue(writer, item, budget);
                    writer.Flush();
                }
                writer.WriteEndObject();
                break;
            case JsonArray array:
                writer.WriteStartArray();
                foreach (var item in array)
                {
                    WriteValue(writer, item, budget);
                    writer.Flush();
                }
                writer.WriteEndArray();
                break;
            case JsonValue scalar when scalar.TryGetValue<string>(out var text):
                if (text.Length == 0)
                {
                    writer.WriteStringValue("");
                    break;
                }
                for (var offset = 0; offset < text.Length; )
                {
                    var length = Math.Min(StringChunk, text.Length - offset);
                    if (
                        offset + length < text.Length
                        && char.IsHighSurrogate(text[offset + length - 1])
                        && char.IsLowSurrogate(text[offset + length])
                    )
                        length--;
                    writer.WriteStringValueSegment(
                        text.AsSpan(offset, length),
                        offset + length == text.Length
                    );
                    writer.Flush();
                    offset += length;
                }
                break;
            default:
                value.WriteTo(writer);
                break;
        }
    }
}
