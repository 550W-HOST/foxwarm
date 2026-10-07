using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal sealed record GeneratedImageNormalization(
    Dictionary<int, JsonObject> Parts,
    IReadOnlyList<string> Failures,
    int SuccessfulCount,
    IReadOnlyDictionary<string, byte[]> ReplayBytes
);

internal static class HostedResponsesTools
{
    internal const int MaxImageBytes = 32 * 1024 * 1024;
    internal const int MaxResponseBytes = 64 * 1024 * 1024;
    internal const int MaxImages = 8;
    private static readonly string[] SafeImageKeys =
    [
        "type",
        "id",
        "status",
        "output_format",
        "output_compression",
        "background",
        "size",
        "quality",
        "action",
        "revised_prompt",
        "created_at",
        "model",
    ];

    internal static JsonObject? BuildWebSearchTool(JsonObject? config)
    {
        if (config?["enabled"]?.GetValue<bool>() != true)
            return null;
        var tool = new JsonObject { ["type"] = "web_search" };
        if (Text(config["searchContextSize"]) is string context)
            tool["search_context_size"] = context;
        if (config["allowedDomains"] is JsonArray domains && domains.Count > 0)
            tool["filters"] = new JsonObject
            {
                ["allowed_domains"] = new JsonArray(
                    domains.Select(value => (JsonNode?)JsonValue.Create(Text(value))).ToArray()
                ),
            };
        if (config["userLocation"] is JsonObject location)
        {
            var normalized = new JsonObject { ["type"] = "approximate" };
            foreach (var key in new[] { "country", "city", "region", "timezone" })
                if (Text(location[key]) is string value && value.Trim().Length > 0)
                    normalized[key] = value.Trim();
            tool["user_location"] = normalized;
        }
        return tool;
    }

    internal static bool IsGeneratedImage(JsonObject item) =>
        Text(item["type"]) == "image_generation_call";

    internal static bool IsCompletedGeneratedImage(JsonObject item) =>
        IsGeneratedImage(item)
        && (item["status"] is null || Text(item["status"]) == "completed")
        && Text(item["result"]) is { Length: > 0 };

    internal static async Task<GeneratedImageNormalization> ExternalizeAsync(
        JsonArray output,
        ImageBlobStore images,
        string sourceModelId,
        CancellationToken token
    )
    {
        var parts = new Dictionary<int, JsonObject>();
        var failures = new List<string>();
        var usedIds = new HashSet<string>(StringComparer.Ordinal);
        var usedBytes = 0;
        var success = 0;
        var replayBytes = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        for (var index = 0; index < output.Count; index++)
        {
            if (output[index] is not JsonObject item || !IsGeneratedImage(item))
                continue;
            var imageId = ImageId(Text(item["id"]), index);
            while (!usedIds.Add(imageId))
                imageId +=
                    "_" + (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (!IsCompletedGeneratedImage(item))
            {
                failures.Add(imageId + ": image generation result was missing or incomplete.");
                continue;
            }
            if (success >= MaxImages)
            {
                failures.Add(imageId + ": response exceeded the image limit.");
                continue;
            }
            try
            {
                var bytes = DecodeBase64(Text(item["result"])!, MaxImageBytes);
                if (usedBytes + bytes.Length > MaxResponseBytes)
                    throw new InvalidDataException(
                        "response exceeded the generated image byte budget."
                    );
                var mime = DetectMime(bytes);
                if (mime is null)
                    throw new InvalidDataException(
                        "image result bytes were not a supported raster image."
                    );
                var declared = DeclaredMime(Text(item["output_format"]));
                if (declared is not null && declared != mime)
                    throw new InvalidDataException(
                        "image result MIME did not match output_format."
                    );
                var reference = await images
                    .PutAsync(bytes, mime, imageId, token)
                    .ConfigureAwait(false);
                var safe = SafeMetadata(item);
                if (safe["output_format"] is null)
                    safe["output_format"] = mime switch
                    {
                        "image/jpeg" => "jpeg",
                        "image/png" => "png",
                        "image/webp" => "webp",
                        _ => "gif",
                    };
                parts[index] = new JsonObject
                {
                    ["inlineDataRef"] = reference,
                    ["imageMeta"] = new JsonObject
                    {
                        ["imageId"] = imageId,
                        ["origin"] = "generated",
                        ["mimeType"] = mime,
                        ["sizeBytes"] = bytes.Length,
                        ["sha256"] = reference["sha256"]?.DeepClone(),
                        ["width"] = reference["width"]?.DeepClone(),
                        ["height"] = reference["height"]?.DeepClone(),
                    },
                    ["providerMeta"] = new JsonObject
                    {
                        ["openaiResponses"] = new JsonObject
                        {
                            ["sourceModelId"] = sourceModelId,
                            ["outputItem"] = safe,
                        },
                    },
                };
                usedBytes += bytes.Length;
                success++;
                if (Text(reference["blobId"]) is string blobId)
                    replayBytes[blobId] = bytes;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception error)
            {
                failures.Add(imageId + ": " + error.Message);
            }
        }
        return new(parts, failures, success, replayBytes);
    }

    internal static JsonObject BuildReplayItem(JsonObject metadata, byte[] bytes)
    {
        var replay = SafeMetadata(metadata);
        replay["type"] = "image_generation_call";
        replay["result"] = Convert.ToBase64String(bytes);
        replay.Remove("quality");
        replay.Remove("background");
        replay.Remove("output_compression");
        replay.Remove("action");
        return replay;
    }

    internal static string Guidance(JsonObject part)
    {
        var metadata = part["imageMeta"] as JsonObject;
        var reference = part["inlineDataRef"] as JsonObject;
        var imageId = Text(metadata?["imageId"]) ?? Text(reference?["imageId"]) ?? "image";
        var width = Number(metadata?["width"] ?? reference?["width"]) ?? "?";
        var height = Number(metadata?["height"] ?? reference?["height"]) ?? "?";
        var mime = Text(metadata?["mimeType"]) ?? Text(reference?["mimeType"]);
        var extension = mime switch
        {
            "image/jpeg" => "jpg",
            "image/png" or "image/webp" or "image/gif" => mime[6..],
            _ => "png",
        };
        var fileName = new string(
            imageId
                .Select(character =>
                    char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-'
                        ? character
                        : '_'
                )
                .ToArray()
        );
        return $"[IMAGE: id={imageId}, size={width}x{height}] you can use image_crop({{ id: \"{imageId}\", x: 0, y: 0, width: 100, height: 100 }}) and image_write_to_file({{ id: \"{imageId}\", filePath: \"artifacts/{fileName}.{extension}\" }})";
    }

    internal static string Placeholder(JsonObject part) =>
        "[an assistant-generated image is present earlier in this conversation; "
        + "the current model does not receive its image content]\n"
        + Guidance(part);

    internal static string FailureNote(IReadOnlyList<string> failures)
    {
        var text = string.Join("; ", failures);
        return text.Length > 600 ? text[..600] + "…" : text;
    }

    private static JsonObject SafeMetadata(JsonObject item)
    {
        var result = new JsonObject();
        foreach (var key in SafeImageKeys)
            if (item[key] is JsonNode value)
                result[key] =
                    key == "revised_prompt"
                        ? JsonValue.Create(BoundedText(Text(value)))
                        : value.DeepClone();
        result["type"] = "image_generation_call";
        return result;
    }

    private static string ImageId(string? callId, int index)
    {
        var safe = new string(
            (callId ?? "")
                .Where(character =>
                    character
                        is >= 'A'
                            and <= 'Z'
                            or >= 'a'
                            and <= 'z'
                            or >= '0'
                            and <= '9'
                            or '_'
                            or '-'
                )
                .ToArray()
        );
        return safe.Length > 0 ? "ig_" + safe : "ig_image" + (index + 1);
    }

    private static byte[] DecodeBase64(string value, int maxBytes)
    {
        var compact = new string(
            value.Where(character => !OpenAIRequestText.IsWhitespace(character)).ToArray()
        );
        if (compact.Length == 0 || compact.Any(character => !IsBase64Ascii(character)))
            throw new InvalidDataException("image result contained invalid base64.");
        var firstPadding = compact.IndexOf('=');
        if (firstPadding >= 0 && compact[firstPadding..].Any(character => character != '='))
            throw new InvalidDataException("image result contained invalid base64 padding.");
        var padding = compact.Length - compact.TrimEnd('=').Length;
        if (padding > 2 || compact.Length % 4 == 1 || padding > 0 && compact.Length % 4 != 0)
            throw new InvalidDataException("image result contained inconsistent base64 padding.");
        var estimatedBytes = (compact.Length - padding) * 3 / 4;
        if (estimatedBytes > maxBytes)
            throw new InvalidDataException("image result exceeded the decoded byte limit.");
        var padded = compact + new string('=', (4 - compact.Length % 4) % 4);
        var bytes = Convert.FromBase64String(padded);
        if (bytes.Length == 0 || bytes.Length > maxBytes)
            throw new InvalidDataException("image result exceeded the decoded byte limit.");
        if (Convert.ToBase64String(bytes).TrimEnd('=') != compact.TrimEnd('='))
            throw new InvalidDataException("image result was not canonical base64.");
        return bytes;
    }

    private static string? DetectMime(byte[] bytes) =>
        bytes.Length >= 8
        && bytes[0] == 0x89
        && bytes[1] == 0x50
        && bytes[2] == 0x4E
        && bytes[3] == 0x47
        && bytes[4] == 0x0D
        && bytes[5] == 0x0A
        && bytes[6] == 0x1A
        && bytes[7] == 0x0A
            ? "image/png"
        : bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF
            ? "image/jpeg"
        : bytes.Length >= 12
        && Encoding.ASCII.GetString(bytes, 0, 4) == "RIFF"
        && Encoding.ASCII.GetString(bytes, 8, 4) == "WEBP"
            ? "image/webp"
        : bytes.Length >= 6 && Encoding.ASCII.GetString(bytes, 0, 6) is "GIF87a" or "GIF89a"
            ? "image/gif"
        : null;

    private static string? BoundedText(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null
            : trimmed.Length > 2000 ? trimmed[..2000]
            : trimmed;
    }

    private static bool IsBase64Ascii(char value) =>
        value is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '+' or '/' or '=';

    private static string? DeclaredMime(string? format) =>
        format switch
        {
            "png" => "image/png",
            "jpeg" or "jpg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => null,
        };

    private static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static string? Number(JsonNode? node)
    {
        if (node is not JsonValue value)
            return null;
        if (value.TryGetValue<int>(out var integer))
            return integer.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (value.TryGetValue<long>(out var longValue))
            return longValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (value.TryGetValue<double>(out var number))
            return number.ToString("0", System.Globalization.CultureInfo.InvariantCulture);
        return null;
    }
}
