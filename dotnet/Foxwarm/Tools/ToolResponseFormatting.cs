using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Encodings.Web;
using System.Text.RegularExpressions;

namespace Foxwarm.Tools;

internal static class ToolResponseFormatting
{
    private static readonly JsonSerializerOptions QuotedOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    internal static string Format(JsonNode? value)
    {
        if (value is JsonObject { Count: 1 } single && single.ContainsKey("output")) value = single["output"];
        if (value is null) return "";
        if (value is JsonValue leaf) return leaf.TryGetValue<string>(out var text) ? text : leaf.ToJsonString();
        if (value is JsonObject { Count: 0 }) return "{}";
        if (value is JsonObject obj) return string.Join('\n', obj.Select(pair => Scalar(pair.Key) + ": " + Flow(pair.Value)));
        return Flow(value);
    }
    private static string Flow(JsonNode? value) => value switch
    {
        null => "null",
        JsonObject obj => "{" + string.Join(", ", obj.Select(pair => Scalar(pair.Key) + ": " + Flow(pair.Value))) + "}",
        JsonArray array => "[" + string.Join(", ", array.Select(Flow)) + "]",
        JsonValue leaf when leaf.TryGetValue<string>(out var text) => Scalar(text),
        _ => value.ToJsonString()
    };
    private static string Scalar(string text)
    {
        if (text.Length > 0 && Regex.IsMatch(text, "^[a-zA-Z_][a-zA-Z0-9_./-]*$", RegexOptions.CultureInvariant)
            && text is not ("true" or "false" or "null" or "True" or "False" or "Null" or "NULL" or "TRUE" or "FALSE")) return text;
        return JsonSerializer.Serialize(text, QuotedOptions);
    }
}
