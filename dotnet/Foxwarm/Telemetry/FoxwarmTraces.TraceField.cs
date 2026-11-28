using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Telemetry;

internal sealed partial class FoxwarmTraces
{
    // One budget per attribute, including entries examined but not emitted (empty or
    // unrecognized parts, old system messages, etc.). Never serialize the source tree.
    private sealed class TraceField
    {
        private int visits = 512;
        private int characters = FieldBytes / 2;

        internal bool Visit() => --visits >= 0 && characters > 0;

        internal IEnumerable<JsonObject> Objects(JsonNode? value, bool reverse = false)
        {
            if (value is not JsonArray array)
                yield break;
            for (var i = 0; i < array.Count && Visit(); i++)
                if (array[reverse ? array.Count - 1 - i : i] is JsonObject item)
                    yield return item;
        }

        private static bool OversizedElement(JsonValue value) =>
            value.TryGetValue<JsonElement>(out var element)
            && JsonMarshal.GetRawUtf8Value(element).Length > FieldBytes;

        // Field discriminators and roles can come from provider-controlled JSON too.
        internal static string? Token(JsonNode? node) =>
            node is JsonValue scalar
            && !OversizedElement(scalar)
            && SessionWait.Text(scalar) is { Length: <= 128 } text
                ? text
                : null;

        internal string? Text(JsonNode? node)
        {
            if (node is not JsonValue value || characters == 0)
                return null;
            // Reading a parsed JSON string otherwise decodes the complete scalar.
            if (OversizedElement(value))
                return "…";
            return SessionWait.Text(value) is { } text ? Take(text) : null;
        }

        private string Take(string text)
        {
            var length = Math.Min(Math.Min(text.Length, characters), 2048);
            characters -= length;
            if (length == text.Length)
                return text;
            if (length > 0 && char.IsHighSurrogate(text[length - 1]))
                length--;
            return text[..length] + "…";
        }

        internal JsonObject Part(string text, string type = "text") =>
            new() { ["type"] = type, ["content"] = text };

        internal JsonObject Image(JsonNode? mime, JsonNode? data, JsonNode? uri)
        {
            var image = new JsonObject { ["modality"] = "image", ["mime_type"] = Text(mime) };
            var value = Text(data ?? uri);
            if (value is null || value.EndsWith('…'))
                image["type"] = "truncated_image";
            else
            {
                image["type"] = data is null ? "uri" : "blob";
                image[data is null ? "uri" : "content"] = value;
            }
            return image;
        }

        internal JsonArray? Records(IEnumerable<JsonObject> source, bool newestFirst = false)
        {
            var rows = new List<JsonObject>();
            var remaining = FieldBytes - 2;
            foreach (var item in source)
            {
                var size = Encoding.UTF8.GetByteCount(item.ToJsonString(ContentJson));
                if (size > remaining)
                    break;
                rows.Add(item);
                remaining -= size + 1;
                if (remaining < 16)
                    break;
            }
            if (newestFirst)
                rows.Reverse();
            return rows.Count == 0 ? null : new JsonArray(rows.ToArray());
        }

        internal JsonObject CopyObject(
            JsonObject source,
            bool omitValue,
            SecretRedactor? secrets,
            int depth = 0
        )
        {
            var result = new JsonObject();
            foreach (var (key, value) in source)
            {
                if (!Visit())
                    break;
                if (omitValue && key == "value")
                    continue;
                if (key.Length > 256 || secrets?.Contains(key) == true)
                    continue;
                characters = Math.Max(0, characters - key.Length);
                result[key] = Copy(value, secrets, depth + 1);
            }
            return result;
        }

        internal JsonNode? Copy(JsonNode? source, SecretRedactor? secrets = null, int depth = 0)
        {
            if (source is null)
                return null;
            if (!Visit() || depth > 24)
                return "…";
            if (source is JsonObject obj)
                return CopyObject(obj, false, secrets, depth);
            if (source is JsonArray array)
            {
                var result = new JsonArray();
                foreach (var item in array)
                {
                    if (!Visit())
                        break;
                    result.Add(Copy(item, secrets, depth + 1));
                }
                return result;
            }
            var scalar = source.AsValue();
            if (OversizedElement(scalar))
                return "…";
            if (SessionWait.Text(scalar) is { } text)
            {
                // Never truncate before masking: a prefix could reveal a partial credential.
                if (secrets is { IsEmpty: false } && text.Length > characters)
                    return "…";
                return Take(secrets?.Redact(text) ?? text);
            }
            return scalar.DeepClone();
        }
    }
}
