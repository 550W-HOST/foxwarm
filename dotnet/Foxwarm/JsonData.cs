using System.Collections;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization.Metadata;

namespace Foxwarm;

// Dynamic envelopes contain JSON values and collections. Domain DTOs use the
// generated metadata below; no reflection fallback participates in either build.
internal static class JsonData
{
    internal static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = MainJsonContext.Default,
    };

    internal static readonly JsonSerializerOptions WebOptions = new(JsonSerializerDefaults.Web)
    {
        TypeInfoResolver = MainJsonContext.Default,
    };

    internal static JsonNode? WebNode(object? value) => Node(value, WebOptions);

    internal static JsonNode? Node(object? value, JsonSerializerOptions? options = null)
    {
        options ??= Options;
        if (value is null)
            return null;
        if (value is JsonNode node)
            return node.DeepClone();
        if (value is JsonElement element)
            return JsonNode.Parse(element.GetRawText());
        if (value is IDictionary dictionary)
        {
            var result = new JsonObject();
            foreach (DictionaryEntry entry in dictionary)
                result.Add((string)entry.Key, Node(entry.Value, options));
            return result;
        }
        if (value is IEnumerable sequence && value is not string && value is not byte[])
        {
            var result = new JsonArray();
            foreach (var item in sequence)
                result.Add(Node(item, options));
            return result;
        }
        return JsonSerializer.SerializeToNode(value, options.GetTypeInfo(value.GetType()));
    }

    private static JsonNode? Value(object? value, JsonSerializerOptions? options) =>
        value as JsonNode ?? Node(value, options);

    private static JsonTypeInfo<JsonNode> NodeInfo(JsonSerializerOptions? options) =>
        (JsonTypeInfo<JsonNode>)(options ?? Options).GetTypeInfo(typeof(JsonNode));

    internal static string Serialize(object? value, JsonSerializerOptions? options = null) =>
        JsonSerializer.Serialize(Value(value, options), NodeInfo(options));

    internal static byte[] SerializeToUtf8Bytes(
        object? value,
        JsonSerializerOptions? options = null
    ) => JsonSerializer.SerializeToUtf8Bytes(Value(value, options), NodeInfo(options));

    internal static JsonNode? SerializeToNode(
        object? value,
        JsonSerializerOptions? options = null
    ) => Node(value, options);

    internal static JsonElement SerializeToElement(
        object? value,
        JsonSerializerOptions? options = null
    ) => JsonSerializer.SerializeToElement(Value(value, options), NodeInfo(options));

    internal static Task SerializeAsync(
        Stream stream,
        object? value,
        JsonSerializerOptions? options = null
    ) => JsonSerializer.SerializeAsync(stream, Value(value, options), NodeInfo(options));

    internal static T? Deserialize<T>(string text, JsonSerializerOptions? options = null) =>
        JsonSerializer.Deserialize(
            text,
            (JsonTypeInfo<T>)(options ?? Options).GetTypeInfo(typeof(T))
        );

    internal static T? Deserialize<T>(
        ReadOnlySpan<byte> text,
        JsonSerializerOptions? options = null
    ) =>
        JsonSerializer.Deserialize(
            text,
            (JsonTypeInfo<T>)(options ?? Options).GetTypeInfo(typeof(T))
        );
}
