using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.MessageJson;

public static class FunctionCallArguments
{
    public static string Stringify(JsonObject? args = null, string? rawArgsText = null, string? argsParseError = null)
    {
        if (!string.IsNullOrEmpty(argsParseError))
        {
            var error = new JsonObject { ["error"] = argsParseError };
            if (!string.IsNullOrEmpty(rawArgsText)) error["rawArgsText"] = rawArgsText;
            return error.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
        }
        if (rawArgsText is not null) return rawArgsText;
        return (args ?? new JsonObject()).ToJsonString(new JsonSerializerOptions { WriteIndented = false });
    }

    public static ParsedArguments Parse(JsonNode? raw)
    {
        if (raw is null) return new ParsedArguments(new JsonObject());
        if (raw is JsonObject obj) return new ParsedArguments((JsonObject)obj.DeepClone());
        if (raw is not JsonValue value || !value.TryGetValue<string>(out var text))
            return new ParsedArguments(new JsonObject(), JsString(raw), $"Invalid tool arguments JSON: expected an object string, received {JsonType(raw)}");
        if (text.Length == 0) return new ParsedArguments(new JsonObject());
        try
        {
            var parsed = JsonNode.Parse(text);
            if (parsed is not JsonObject parsedObject)
                return new ParsedArguments(new JsonObject(), text, $"Invalid tool arguments JSON: expected top-level object but received {ParsedJsonType(parsed)}");
            return new ParsedArguments((JsonObject)parsedObject.DeepClone(), text);
        }
        catch (JsonException error)
        {
            // Keep the stable JS error for the representative truncated-object boundary.
            var detail = text == "{" ? "Expected property name or '}' in JSON at position 1 (line 1 column 2)" : error.Message;
            return new ParsedArguments(new JsonObject(), text, $"Invalid tool arguments JSON: {detail}");
        }
    }

    private static string JsString(JsonNode value) => value switch
    {
        JsonArray array => string.Join(',', array.Select(item => item is null ? "" : JsString(item))),
        JsonObject => "[object Object]",
        JsonValue scalar when scalar.TryGetValue<string>(out var text) => text,
        JsonValue scalar when scalar.TryGetValue<bool>(out var boolean) => boolean ? "true" : "false",
        JsonValue scalar => scalar.ToJsonString().Trim('"'),
        _ => "undefined"
    };

    private static string JsonType(JsonNode? value) => value switch
    {
        JsonObject => "object", JsonArray => "object", JsonValue v when v.TryGetValue<string>(out _) => "string",
        JsonValue v when v.TryGetValue<bool>(out _) => "boolean", JsonValue => "number", null => "object", _ => "object"
    };

    private static string ParsedJsonType(JsonNode? value) => value switch
    {
        JsonArray => "array", JsonObject => "object", JsonValue v when v.TryGetValue<string>(out _) => "string",
        JsonValue v when v.TryGetValue<bool>(out _) => "boolean", JsonValue => "number", null => "object", _ => "object"
    };
}

public sealed record ParsedArguments(JsonObject Args, string? RawArgsText = null, string? ArgsParseError = null);
