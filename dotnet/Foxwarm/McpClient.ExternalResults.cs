using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;

namespace Foxwarm;

internal sealed partial class McpClient
{
    private static readonly JsonSerializerOptions ExternalResultOptions = new(
        McpJsonUtilities.DefaultOptions
    )
    {
        RespectNullableAnnotations = true,
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
    };

    // Validate only Source's known protocol fields. Never use the deserialized value as
    // output: the SDK DTOs discard extensions and recognize fields newer than Source.
    private static void ValidateExternalResult(JsonNode? result)
    {
        if (result is not JsonObject obj)
            throw new JsonException("Invalid MCP tool result.");
        var known = ExternalProtocolFields(obj, "isError", "structuredContent", "_meta");
        if (
            known["isError"] is { } error
            && error.GetValueKind() is not (JsonValueKind.True or JsonValueKind.False)
        )
            throw new JsonException("Invalid MCP error flag.");
        if (known["structuredContent"] is { } structured && structured is not JsonObject)
            throw new JsonException("Invalid MCP structured content.");
        if (known["_meta"] is { } metadata)
        {
            if (metadata is not JsonObject meta)
                throw new JsonException("Invalid MCP metadata.");
            if (
                meta.TryGetPropertyValue("progressToken", out var progress)
                && !(
                    progress?.GetValueKind() == JsonValueKind.String
                    || progress?.GetValueKind() == JsonValueKind.Number
                        && progress.GetValue<double>() is var number
                        && double.IsFinite(number)
                        && Math.Abs(number) <= 9007199254740991
                        && Math.Truncate(number) == number
                )
            )
                throw new JsonException("Invalid MCP progress token.");
            if (
                meta.TryGetPropertyValue("io.modelcontextprotocol/related-task", out var related)
                && (
                    related is not JsonObject task
                    || task["taskId"]?.GetValueKind() != JsonValueKind.String
                )
            )
                throw new JsonException("Invalid MCP task metadata.");
        }
        if (!obj.TryGetPropertyValue("content", out var content))
            return; // Source's content schema defaults an omitted field to [].
        if (content is not JsonArray blocks)
            throw new JsonException("Invalid MCP content.");
        foreach (var item in blocks)
        {
            if (item is not JsonObject block)
                throw new JsonException("Invalid MCP content block.");
            var common = ExternalProtocolFields(block, "annotations", "_meta");
            if (common["_meta"] is { } blockMeta && blockMeta is not JsonObject)
                throw new JsonException("Invalid MCP content metadata.");
            if (common["annotations"] is { } annotations)
                ValidateExternalAnnotations(annotations);
            switch (SessionWait.Text(block["type"]))
            {
                case "text":
                    ExternalProtocolFields(block, "text")
                        .Deserialize<TextContentBlock>(ExternalResultOptions);
                    break;
                case "image":
                case "audio":
                    var media = ExternalProtocolFields(block, "data", "mimeType");
                    media["data"] = ExternalBase64(media["data"]);
                    if (SessionWait.Text(block["type"]) == "image")
                        media.Deserialize<ImageContentBlock>(ExternalResultOptions);
                    else
                        media.Deserialize<AudioContentBlock>(ExternalResultOptions);
                    break;
                case "resource":
                    if (block["resource"] is not JsonObject resource)
                        throw new JsonException("Invalid MCP resource.");
                    var fields = ExternalProtocolFields(resource, "uri", "mimeType", "_meta");
                    if (fields["_meta"] is { } resourceMeta && resourceMeta is not JsonObject)
                        throw new JsonException("Invalid MCP resource metadata.");
                    // Source's text/blob union accepts either branch without inspecting
                    // the other branch's opaque fields. Avoid the SDK's union converter.
                    if (resource["text"]?.GetValueKind() == JsonValueKind.String)
                    {
                        fields["text"] = resource["text"]!.DeepClone();
                        fields.Deserialize<TextResourceContents>(ExternalResultOptions);
                    }
                    else
                    {
                        fields["blob"] = ExternalBase64(resource["blob"]);
                        fields.Deserialize<BlobResourceContents>(ExternalResultOptions);
                    }
                    break;
                case "resource_link":
                    var link = ExternalProtocolFields(
                        block,
                        "uri",
                        "name",
                        "title",
                        "description",
                        "mimeType"
                    );
                    link.Deserialize<ResourceLinkBlock>(ExternalResultOptions);
                    if (block.TryGetPropertyValue("icons", out var icons))
                    {
                        if (icons is not JsonArray array)
                            throw new JsonException("Invalid MCP icons.");
                        foreach (var icon in array)
                        {
                            if (icon is not JsonObject descriptor)
                                throw new JsonException("Invalid MCP icon.");
                            var iconFields = ExternalProtocolFields(
                                descriptor,
                                "src",
                                "mimeType",
                                "sizes",
                                "theme"
                            );
                            if (
                                iconFields["sizes"] is { } sizes
                                && (
                                    sizes is not JsonArray entries
                                    || entries.Any(entry =>
                                        entry?.GetValueKind() != JsonValueKind.String
                                    )
                                )
                            )
                                throw new JsonException("Invalid MCP icon sizes.");
                            if (
                                iconFields["theme"] is { } theme
                                && SessionWait.Text(theme) is not ("light" or "dark")
                            )
                                throw new JsonException("Invalid MCP icon theme.");
                            iconFields.Deserialize<Icon>(ExternalResultOptions);
                        }
                    }
                    break;
                default:
                    throw new JsonException("Invalid MCP content type.");
            }
        }
    }

    private static JsonObject ExternalProtocolFields(JsonObject source, params string[] names)
    {
        var result = new JsonObject();
        foreach (var name in names)
            if (source.TryGetPropertyValue(name, out var value))
                result[name] =
                    value?.DeepClone() ?? throw new JsonException("Null MCP protocol field.");
        return result;
    }

    private static string ExternalBase64(JsonNode? value)
    {
        if (value?.GetValueKind() != JsonValueKind.String)
            throw new JsonException("Invalid MCP binary data.");
        // Source uses atob: ASCII whitespace and omitted padding are legal. The
        // discarded SDK validation copy needs padding; the returned raw data does not.
        var compact = string.Concat(
            value.GetValue<string>().Where(c => c is not (' ' or '\t' or '\r' or '\n' or '\f'))
        );
        if (compact.Length % 4 == 1 || compact.Length % 4 != 0 && compact.Contains('='))
            throw new JsonException("Invalid MCP binary data.");
        var padded = compact.PadRight((compact.Length + 3) / 4 * 4, '=');
        _ = Convert.FromBase64String(padded);
        return padded;
    }

    private static void ValidateExternalAnnotations(JsonNode value)
    {
        if (value is not JsonObject annotations)
            throw new JsonException("Invalid MCP annotations.");
        var fields = ExternalProtocolFields(annotations, "audience", "priority", "lastModified");
        if (
            fields["audience"] is { } audience
            && (
                audience is not JsonArray roles
                || roles.Any(role => SessionWait.Text(role) is not ("user" or "assistant"))
            )
        )
            throw new JsonException("Invalid MCP audience.");
        if (
            fields["priority"] is { } priority
            && (
                priority.GetValueKind() != JsonValueKind.Number
                || priority.GetValue<double>() is not (>= 0 and <= 1)
            )
        )
            throw new JsonException("Invalid MCP priority.");
        if (fields["lastModified"] is { } modified)
        {
            // Match Source's ISO date/time shape, including optional seconds,
            // arbitrary fractional precision and its two-digit offset grammar.
            var text = modified.GetValue<string>();
            if (
                !Regex.IsMatch(
                    text,
                    @"\A[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})\z",
                    RegexOptions.CultureInvariant
                )
            )
                throw new JsonException("Invalid MCP modification time.");
            var year = int.Parse(text.AsSpan(0, 4), CultureInfo.InvariantCulture);
            var month = int.Parse(text.AsSpan(5, 2), CultureInfo.InvariantCulture);
            var day = int.Parse(text.AsSpan(8, 2), CultureInfo.InvariantCulture);
            if (day > DateTime.DaysInMonth(year == 0 ? 400 : year, month))
                throw new JsonException("Invalid MCP modification date.");
        }
    }
}
