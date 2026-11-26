using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Postgres.Authority;

/// <summary>
/// The head's envelope: the prepared authority state without history, as compact UTF-8 JSON
/// that keeps the position of the <c>history</c> property. Every top-level string member of
/// <see cref="PartBytes"/> or more is stored once per value as a part and referenced by its
/// SHA-256; the envelope holds null in its place. The rule is generic: no member is named.
/// </summary>
internal sealed class PgSessionEnvelope
{
    /// <summary>The UTF-8 size from which a top-level string member becomes a part.</summary>
    internal const int PartBytes = 4 * 1024;

    private static readonly UTF8Encoding StrictUtf8 = new(false, throwOnInvalidBytes: true);

    private PgSessionEnvelope(
        byte[] bytes,
        SortedDictionary<string, string> parts,
        Dictionary<string, byte[]> values
    )
    {
        Bytes = bytes;
        Parts = parts;
        Values = values;
    }

    internal byte[] Bytes { get; }

    /// <summary>Member name to the hex SHA-256 of its part.</summary>
    internal SortedDictionary<string, string> Parts { get; }

    /// <summary>Part values by hex SHA-256.</summary>
    internal Dictionary<string, byte[]> Values { get; }

    internal string PartsJson => FormatParts(Parts);

    /// <summary>
    /// Encodes <paramref name="state"/>; a <c>history</c> member must be null, its position
    /// marking where the records belong.
    /// </summary>
    internal static PgSessionEnvelope Encode(JsonObject state)
    {
        var parts = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var values = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        using var stream = new MemoryStream();
        using (
            var writer = new Utf8JsonWriter(
                stream,
                SessionAuthorityDocument.WriterOptions(indented: false)
            )
        )
        {
            writer.WriteStartObject();
            foreach (var property in state)
            {
                writer.WritePropertyName(property.Key);
                if (property.Key == "history" && property.Value is not null)
                    throw new InvalidOperationException("The envelope holds no history records.");
                if (Part(property.Value) is { } value)
                {
                    var hash = Convert.ToHexStringLower(SHA256.HashData(value));
                    parts[property.Key] = hash;
                    values[hash] = value;
                    writer.WriteNullValue();
                }
                else if (property.Value is null)
                    writer.WriteNullValue();
                else
                    property.Value.WriteTo(writer);
            }
            writer.WriteEndObject();
        }
        return new(stream.ToArray(), parts, values);
    }

    /// <summary>
    /// The stored state: the envelope with every part member restored in its position.
    /// <paramref name="values"/> holds the part values by hex SHA-256.
    /// </summary>
    internal static JsonObject Decode(
        byte[] envelope,
        IReadOnlyDictionary<string, string> parts,
        IReadOnlyDictionary<string, byte[]> values
    )
    {
        var root =
            JsonNode.Parse(envelope) as JsonObject
            ?? throw new InvalidDataException("Session authority envelope must be a JSON object.");
        foreach (var (member, hash) in parts)
        {
            if (!root.ContainsKey(member) || root[member] is not null)
                throw new InvalidDataException("Session authority part has no envelope member.");
            if (!values.TryGetValue(hash, out var value))
                throw new InvalidDataException("Session authority part is missing.");
            // Replacing an existing member keeps its position.
            root[member] = JsonValue.Create(StrictUtf8.GetString(value));
        }
        return root;
    }

    internal static string FormatParts(IReadOnlyDictionary<string, string> parts)
    {
        var json = new JsonObject();
        foreach (var (member, hash) in parts)
            json[member] = hash;
        return json.ToJsonString();
    }

    internal static Dictionary<string, string> ParseParts(string json)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (JsonNode.Parse(json) is not JsonObject parts)
            throw new InvalidDataException("Session authority parts must be a JSON object.");
        foreach (var (member, hash) in parts)
            result[member] =
                hash is JsonValue value && value.TryGetValue<string>(out var text)
                    ? text
                    : throw new InvalidDataException("Session authority part hash must be text.");
        return result;
    }

    // A string member of at least PartBytes as UTF-8. Strings that aren't valid UTF-16 stay
    // inline, so a part always decodes to the same value.
    private static byte[]? Part(JsonNode? node)
    {
        if (
            node is not JsonValue value
            || value.GetValueKind() != JsonValueKind.String
            || !value.TryGetValue<string>(out var text)
            || text.Length * 3 < PartBytes
        )
            return null;
        byte[] bytes;
        try
        {
            bytes = StrictUtf8.GetBytes(text);
        }
        catch (EncoderFallbackException)
        {
            return null;
        }
        return bytes.Length >= PartBytes ? bytes : null;
    }
}
