using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

// Model-facing text of tool results; the port of packages/shared/src/toolResponseFormatting.ts,
// which the WebUI uses for the same results. Both produce identical text
// (packages/shared/src/toolResponseFormatting.fixtures.json runs against both).
internal static class ToolResponseFormatting
{
    internal static string Format(JsonNode? value)
    {
        if (value is JsonObject { Count: 1 } single && single.ContainsKey("output"))
            value = single["output"];
        return FormatStructuredValue(value);
    }

    // Strings as they are; a mapping or sequence as YAML in the readable layout.
    internal static string FormatStructuredValue(JsonNode? value)
    {
        if (value is null)
            return "";
        if (value is JsonValue leaf)
            return leaf.GetValueKind() switch
            {
                JsonValueKind.String => leaf.GetValue<string>(),
                JsonValueKind.Number => ToolResponseYaml.JavaScriptNumber(
                    ToolResponseYaml.NumberValue(leaf)
                ),
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                JsonValueKind.Null => "",
                _ => leaf.ToJsonText(),
            };
        return ToolResponseYaml.Dump(value, ToolResponseYaml.Readable);
    }

    // A cleaned outer ToolScript execution result: print and return sections, then metadata.
    internal static string FormatToolScriptExecution(JsonNode? value)
    {
        if (
            value is not JsonObject response
            || Flag(response["truncated"])
            || Flag(response["outputTruncated"])
            || response.ContainsKey("output")
                && !response.ContainsKey("result")
                && !response.ContainsKey("stdout")
        )
            return Format(value);
        var metadata = new JsonObject();
        foreach (var (key, item) in response)
            if (key is not ("stdout" or "result" or "output"))
                metadata[key] = item?.DeepClone();
        var sections = new StringBuilder();
        void AppendSection(string label, string text)
        {
            sections.Append("--- ").Append(label).Append(" ---\n").Append(text);
            if (!text.EndsWith('\n'))
                sections.Append('\n');
        }
        if (
            response["stdout"] is JsonValue stdout
            && stdout.GetValueKind() == JsonValueKind.String
            && stdout.GetValue<string>() is { Length: > 0 } printed
        )
            AppendSection("print", printed);
        if (response.ContainsKey("result"))
            AppendSection(
                "return",
                response["result"] is JsonValue result
                && result.GetValueKind() == JsonValueKind.String
                    ? result.GetValue<string>()
                    : ToolResponseYaml.Dump(response["result"], -1)
            );
        return sections.Append("---\n").Append(ToolResponseYaml.Dump(metadata, -1)).ToString();
    }

    private static bool Flag(JsonNode? value) =>
        value is JsonValue flag && flag.GetValueKind() == JsonValueKind.True;
}
