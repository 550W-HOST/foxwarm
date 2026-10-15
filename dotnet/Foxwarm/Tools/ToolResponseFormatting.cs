using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.Serialization;
using YamlDotNet.Serialization.EventEmitters;

namespace Foxwarm.Tools;

internal static class ToolResponseFormatting
{
    private static readonly JsonSerializerOptions QuotedOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static string Format(JsonNode? value)
    {
        if (value is JsonObject { Count: 1 } single && single.ContainsKey("output"))
            value = single["output"];
        if (value is null)
            return "";
        if (value is JsonValue leaf)
            return leaf.TryGetValue<string>(out var text) ? text : leaf.ToJsonString();
        if (value is JsonObject { Count: 0 })
            return "{}";
        if (value is JsonObject obj)
            return string.Join(
                '\n',
                obj.Select(pair => Scalar(pair.Key) + ": " + Flow(pair.Value))
            );
        return Flow(value);
    }

    private static readonly ISerializer BlockYaml = new SerializerBuilder()
        .DisableAliases()
        .WithIndentedSequences()
        .WithEventEmitter(next => new LiteralBlockEmitter(next))
        .WithQuotingNecessaryStrings()
        .WithNewLine("\n")
        .Build();

    private sealed class LiteralBlockEmitter(IEventEmitter next) : ChainedEventEmitter(next)
    {
        public override void Emit(ScalarEventInfo info, IEmitter emitter)
        {
            if (info.Source.Value is string text && text.Contains('\n'))
                info.Style = ScalarStyle.Literal;
            else if (info.Source.Value is null)
                info.RenderedValue = "null";
            base.Emit(info, emitter);
        }
    }

    internal static string FormatToolScriptExecution(JsonNode? value)
    {
        if (
            value is not JsonObject response
            || response["truncated"] is JsonValue flag
                && flag.TryGetValue<bool>(out var truncated)
                && truncated
            || response["outputTruncated"] is JsonValue outputFlag
                && outputFlag.TryGetValue<bool>(out var outputTruncated)
                && outputTruncated
            || response.ContainsKey("output")
                && !response.ContainsKey("result")
                && !response.ContainsKey("stdout")
        )
            return Format(value);
        var metadata = (JsonObject)response.DeepClone();
        metadata.Remove("stdout");
        metadata.Remove("result");
        metadata.Remove("output");
        var sections = new StringBuilder();
        void AppendSection(string label, string text)
        {
            sections.Append("--- ").Append(label).Append(" ---\n").Append(text);
            if (!text.EndsWith('\n'))
                sections.Append('\n');
        }
        if (
            response["stdout"] is JsonValue stdout
            && stdout.TryGetValue<string>(out var printed)
            && printed.Length > 0
        )
            AppendSection("print", printed);
        if (response.ContainsKey("result"))
            AppendSection(
                "return",
                response["result"] is JsonValue result
                && result.TryGetValue<string>(out var returned)
                    ? returned
                    : DumpBlock(response["result"])
            );
        return sections.Append("---\n").Append(DumpBlock(metadata)).ToString();
    }

    private static string DumpBlock(JsonNode? value) =>
        value is null ? "null" : BlockYaml.Serialize(Native(value)).TrimEnd();

    private static object? Native(JsonNode? value) =>
        value switch
        {
            null => null,
            JsonObject obj => obj.ToDictionary(pair => pair.Key, pair => Native(pair.Value)),
            JsonArray array => array.Select(Native).ToArray(),
            JsonValue leaf when leaf.TryGetValue<string>(out var text) => text,
            JsonValue leaf when leaf.TryGetValue<bool>(out var flag) => flag,
            JsonValue leaf when leaf.TryGetValue<long>(out var integer) => integer,
            _ => JsonSerializer.Deserialize<JsonElement>(value.ToJsonString()).GetDouble(),
        };

    private static string Flow(JsonNode? value) =>
        value switch
        {
            null => "null",
            JsonObject obj => "{"
                + string.Join(", ", obj.Select(pair => Scalar(pair.Key) + ": " + Flow(pair.Value)))
                + "}",
            JsonArray array => "[" + string.Join(", ", array.Select(Flow)) + "]",
            JsonValue leaf when leaf.TryGetValue<string>(out var text) => Scalar(text),
            _ => value.ToJsonString(),
        };

    private static string Scalar(string text)
    {
        if (
            text.Length > 0
            && Regex.IsMatch(text, "^[a-zA-Z_][a-zA-Z0-9_./-]*$", RegexOptions.CultureInvariant)
            && text
                is not (
                    "true"
                    or "false"
                    or "null"
                    or "True"
                    or "False"
                    or "Null"
                    or "NULL"
                    or "TRUE"
                    or "FALSE"
                )
        )
            return text;
        return JsonSerializer.Serialize(text, QuotedOptions);
    }
}
