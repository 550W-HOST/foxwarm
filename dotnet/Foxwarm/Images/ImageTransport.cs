using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Images;

internal static class ImageTransport
{
    internal static JsonNode? Project(JsonNode? value)
    {
        if (value is JsonArray array) return new JsonArray(array.Select(Project).ToArray());
        if (value is not JsonObject source) return value?.DeepClone();
        var result = new JsonObject();
        foreach (var (key, child) in source)
        {
            if (key is "__providerImageIdentity" or "__providerImageDeduplicated") continue;
            if (key == "data" && SessionWait.Text(source["type"]) == "image" && ImageBlobStore.Mime(source).StartsWith("image/", StringComparison.Ordinal)) { result[key] = "[Image data omitted]"; continue; }
            if (key == "inlineData" && child is JsonObject inline && ImageBlobStore.Mime(inline).StartsWith("image/", StringComparison.Ordinal))
            { result["inlineDataUnavailable"] = new JsonObject { ["mimeType"] = ImageBlobStore.Mime(inline), ["reason"] = "Image preview is unavailable." }; continue; }
            if (key == "inlineDataRef" && child is JsonObject reference)
            {
                var copy = new JsonObject();
                foreach (var field in new[] { "imageId", "blobId", "format", "mimeType", "byteLength", "sha256", "width", "height" })
                    if (reference[field] is JsonValue scalar) copy[field] = scalar.DeepClone();
                if (SessionWait.Text(copy["blobId"]) is { } id && Regex.IsMatch(id, "^[a-f0-9]{64}\\.(png|jpg|gif|webp|svg|bin)$"))
                {
                    copy["apiPath"] = "/blobs/" + id; result[key] = copy;
                }
                else result["inlineDataUnavailable"] = new JsonObject { ["mimeType"] = ImageBlobStore.Mime(reference), ["reason"] = "Image preview is unavailable." };
                continue;
            }
            if (key == "inlineDataItems" && child is JsonArray images)
            {
                var kept = images.Where(image => image is not JsonObject item || !ImageBlobStore.Mime(item).StartsWith("image/", StringComparison.Ordinal)).Select(Project).ToArray();
                if (kept.Length > 0) result[key] = new JsonArray(kept);
                continue;
            }
            if (key == "messageJson" && SessionWait.Text(child) is { } raw)
            {
                try { result[key] = Project(JsonNode.Parse(raw))?.ToJsonString(); }
                catch (JsonException) { result[key] = "[Message preview unavailable]"; }
                continue;
            }
            result[key] = Project(child);
        }
        return result;
    }
    internal static string SafeText(string text) => Regex.Replace(text, @"data:image/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+", "[Image data omitted]");
    internal static string DiagnosticBody(string text)
    {
        JsonNode? Scrub(JsonNode? node)
        {
            if (node is JsonValue scalar && scalar.TryGetValue<string>(out var textValue)) return JsonValue.Create(SafeText(textValue));
            if (node is JsonArray array) return new JsonArray(array.Select(Scrub).ToArray());
            if (node is not JsonObject obj) return node?.DeepClone();
            var result = new JsonObject(); var image = ImageBlobStore.Mime(obj).StartsWith("image/", StringComparison.Ordinal);
            foreach (var (key, value) in obj) result[key] = image && key == "data" ? JsonValue.Create("[Image data omitted]") : Scrub(value);
            return Project(result);
        }
        try { return Scrub(JsonNode.Parse(text))?.ToJsonString() ?? ""; }
        catch (JsonException) { return SafeText(text); }
    }
}

internal sealed class ImageTransportConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) => typeof(JsonNode).IsAssignableFrom(typeToConvert);
    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options) =>
        (JsonConverter)Activator.CreateInstance(typeof(Converter<>).MakeGenericType(typeToConvert), nonPublic: true)!;
    private sealed class Converter<T> : JsonConverter<T> where T : JsonNode
    {
        public override T? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => JsonNode.Parse(ref reader) as T;
        public override void Write(Utf8JsonWriter writer, T value, JsonSerializerOptions options) =>
            writer.WriteRawValue(ImageTransport.Project(value)?.ToJsonString() ?? "null");
    }
}
