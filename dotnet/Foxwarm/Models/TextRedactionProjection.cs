using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

// These are semantic text slots, not a walk over the final provider payload.
internal static class TextRedactionProjection
{
    internal static async Task<IReadOnlyList<JsonObject>> HistoryAsync(
        IReadOnlyList<JsonObject> history,
        Func<string, Task<string>> redact
    )
    {
        var result = new List<JsonObject>();
        foreach (var original in history)
        {
            var message = (JsonObject)original.DeepClone();
            await ContentAsync(message, redact);
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
            {
                await FieldAsync(part, "text", redact);
                await FieldAsync(part, "system", redact);
                if (part["functionCall"] is JsonObject call)
                {
                    var parsed = SessionWait.Text(call["rawArgsText"]) is string raw
                        ? FunctionCallArguments.Parse(JsonValue.Create(raw))
                        : null;
                    if (
                        SessionWait.Text(call["argsParseError"]) is { Length: > 0 }
                        || parsed?.ArgsParseError is not null
                    )
                        await FieldAsync(call, "rawArgsText", redact);
                    else if ((parsed?.Args ?? call["args"]) is JsonNode args)
                    {
                        call["args"] = await StringsAsync(args, redact);
                        // Serializers prefer rawArgsText when present. Keep both forms
                        // in agreement after transforming structured string values.
                        if (call.ContainsKey("rawArgsText"))
                            call["rawArgsText"] = call["args"]!.ToJsonString();
                    }
                }
                if (part["functionResponse"] is JsonObject response)
                    response["response"] = new JsonObject
                    {
                        ["output"] = await redact(
                            ToolResponseFormatting.Format(response["response"])
                        ),
                    };
            }
            result.Add(message);
        }
        return result;
    }

    private static async Task ContentAsync(JsonObject message, Func<string, Task<string>> redact)
    {
        await FieldAsync(message, "content", redact);
        if (message["content"] is JsonArray content)
            foreach (var block in content.OfType<JsonObject>())
                if (SessionWait.Text(block["type"]) is "text" or "input_text" or "output_text")
                    await FieldAsync(block, "text", redact);
    }

    internal static async Task<JsonArray?> ToolsAsync(
        JsonArray? tools,
        Func<string, Task<string>> redact
    )
    {
        if (tools is null)
            return null;
        var copy = (JsonArray)tools.DeepClone();
        async Task Schema(JsonNode? node)
        {
            if (node is not JsonObject schema)
                return;
            await FieldAsync(schema, "description", redact);
            foreach (var (keyword, child) in schema)
            {
                if (
                    keyword
                    is "properties"
                        or "patternProperties"
                        or "$defs"
                        or "definitions"
                        or "dependentSchemas"
                        or "dependencies"
                )
                {
                    if (child is JsonObject map)
                        foreach (var (_, nested) in map)
                            await Schema(nested);
                }
                else if (keyword is "allOf" or "anyOf" or "oneOf" or "prefixItems" or "items")
                {
                    if (child is JsonArray array)
                        foreach (var nested in array)
                            await Schema(nested);
                    else
                        await Schema(child);
                }
                else if (
                    keyword
                    is "additionalProperties"
                        or "unevaluatedProperties"
                        or "additionalItems"
                        or "unevaluatedItems"
                        or "propertyNames"
                        or "contains"
                        or "not"
                        or "if"
                        or "then"
                        or "else"
                )
                    await Schema(child);
            }
        }
        foreach (var tool in copy.OfType<JsonObject>())
        {
            await FieldAsync(tool, "description", redact);
            await Schema(tool["parameters"]);
        }
        return copy;
    }

    private static async Task FieldAsync(
        JsonObject obj,
        string field,
        Func<string, Task<string>> redact
    )
    {
        if (SessionWait.Text(obj[field]) is string text)
            obj[field] = await redact(text);
    }

    private static async Task<JsonNode?> StringsAsync(
        JsonNode? node,
        Func<string, Task<string>> transform
    )
    {
        if (SessionWait.Text(node) is string text)
            return JsonValue.Create(await transform(text));
        if (node is JsonObject obj)
        {
            var copy = new JsonObject();
            foreach (var (key, value) in obj)
                copy[key] = await StringsAsync(value, transform);
            return copy;
        }
        if (node is JsonArray array)
        {
            var copy = new JsonArray();
            foreach (var child in array)
                copy.Add(await StringsAsync(child, transform));
            return copy;
        }
        return node?.DeepClone();
    }

    private static JsonNode? RestoreStrings(JsonNode? node, TextRedactor redactor)
    {
        if (SessionWait.Text(node) is string text)
            return JsonValue.Create(redactor.Restore(text));
        if (node is JsonObject obj)
        {
            var copy = new JsonObject();
            foreach (var (key, value) in obj)
                copy[key] = RestoreStrings(value, redactor);
            return copy;
        }
        if (node is JsonArray array)
            return new JsonArray(array.Select(child => RestoreStrings(child, redactor)).ToArray());
        return node?.DeepClone();
    }

    internal static JsonObject RestoreMessage(JsonObject original, TextRedactor redactor)
    {
        var message = (JsonObject)original.DeepClone();
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (SessionWait.Text(part["text"]) is string text)
                part["text"] = redactor.Restore(text);
            if (part["functionCall"] is JsonObject call && call["args"] is JsonObject args)
            {
                call["args"] = RestoreStrings(args, redactor);
                if (
                    call.ContainsKey("rawArgsText")
                    && string.IsNullOrEmpty(SessionWait.Text(call["argsParseError"]))
                )
                    call["rawArgsText"] = call["args"]!.ToJsonString();
            }
        }
        return message;
    }

    internal static ResponsesStreamProgress RestoreProgress(
        ResponsesStreamProgress value,
        TextRedactor redactor
    )
    {
        string? Arguments(string? raw)
        {
            if (raw is null)
                return null;
            try
            {
                return RestoreStrings(JsonNode.Parse(raw), redactor)?.ToJsonString();
            }
            catch (JsonException)
            {
                // Incomplete JSON cannot be restored safely as an argument object.
                return null;
            }
        }
        return value with
        {
            Text = redactor.RestoreProgress(value.Text),
            Parts = value
                .Parts?.Select(part =>
                    part.Kind == "text" && part.Text is string text
                        ? part with
                        {
                            Text = redactor.RestoreProgress(text),
                        }
                        : part
                )
                .ToArray(),
            ToolCalls = value
                .ToolCalls.Select(call => call with { Arguments = Arguments(call.Arguments) })
                .ToArray(),
        };
    }
}
