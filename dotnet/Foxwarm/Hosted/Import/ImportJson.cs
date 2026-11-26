using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Hosted.Import;

/// <summary>
/// Canonical JSON for import verification: object members sorted by ordinal name, no
/// whitespace, numbers as their source text. Two values with equal canonical bytes are the same
/// JSON value apart from member order, so the hash can be compared across representations that
/// keep different bytes (a Session document and its segmented copy).
/// </summary>
internal static class ImportJson
{
    internal static byte[] Canonical(JsonNode? value)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
            Write(writer, value);
        return buffer.ToArray();
    }

    internal static string Sha256(JsonNode? value) => Convert.ToHexStringLower(SHA256.HashData(Canonical(value)));

    /// <summary>Whether two values are equal with member order ignored.</summary>
    internal static bool SameIgnoringOrder(JsonNode? a, JsonNode? b) => Canonical(a).AsSpan().SequenceEqual(Canonical(b));

    /// <summary>Whether two values are equal including member order (the representation's own JSON equality).</summary>
    internal static bool Same(JsonNode? a, JsonNode? b) =>
        JsonNode.DeepEquals(a, b) && Ordered(a, b);

    private static bool Ordered(JsonNode? a, JsonNode? b)
    {
        switch (a, b)
        {
            case (JsonObject x, JsonObject y):
                if (!x.Select(pair => pair.Key).SequenceEqual(y.Select(pair => pair.Key), StringComparer.Ordinal))
                    return false;
                foreach (var (key, value) in x)
                    if (!Ordered(value, y[key]))
                        return false;
                return true;
            case (JsonArray x, JsonArray y):
                for (var index = 0; index < x.Count; index++)
                    if (!Ordered(x[index], y[index]))
                        return false;
                return true;
            default:
                return true;
        }
    }

    private static void Write(Utf8JsonWriter writer, JsonNode? value)
    {
        switch (value)
        {
            case null:
                writer.WriteNullValue();
                break;
            case JsonObject node:
                writer.WriteStartObject();
                foreach (var (key, member) in node.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                {
                    writer.WritePropertyName(key);
                    Write(writer, member);
                }
                writer.WriteEndObject();
                break;
            case JsonArray node:
                writer.WriteStartArray();
                foreach (var item in node)
                    Write(writer, item);
                writer.WriteEndArray();
                break;
            default:
                // A value parsed from text keeps its token, so numbers keep their source text.
                value.WriteTo(writer);
                break;
        }
    }
}
