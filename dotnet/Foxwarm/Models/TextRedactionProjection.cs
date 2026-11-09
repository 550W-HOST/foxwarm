using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Models;

// One text slot of a request history: its message and part, what it is (`text`, `system`,
// `content`, `arguments` for unparsable raw argument text, `argument` for one string value
// at `Path`, `output`) and, for calls and results, the tool name and call ID.
internal readonly record struct TextSlot(
    int Message,
    int Part,
    string Kind,
    string? Path = null,
    string? Name = null,
    string? CallId = null
);

// These are semantic text slots, not a walk over the final provider payload.
internal static class TextRedactionProjection
{
    // Argument JSON keeps non-ASCII and HTML characters literal, as tool output does.
    private static readonly JsonSerializerOptions ArgumentJson = new()
    {
        TypeInfoResolver = MainJsonContext.Default,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static string Serialize(JsonNode? node) => node?.ToJsonString(ArgumentJson) ?? "null";

    // The configured request owner has already made this copy and hydrated its
    // image parts. Mutate text slots in place to retain request-local part identity.
    internal static Task RedactHistoryAsync(
        IReadOnlyList<JsonObject> history,
        Func<string, Task<string>> redact
    ) => RedactSlotsAsync(history, (_, text) => redact(text));

    // The same walk, telling the callback which slot each text belongs to.
    internal static async Task RedactSlotsAsync(
        IReadOnlyList<JsonObject> history,
        Func<TextSlot, string, Task<string>> redactSlot
    )
    {
        for (var index = 0; index < history.Count; index++)
        {
            var message = history[index];
            await ContentAsync(message, text => redactSlot(new(index, -1, "content"), text));
            var parts = (message["parts"] as JsonArray ?? []).ToArray();
            for (var partIndex = 0; partIndex < parts.Length; partIndex++)
            {
                if (parts[partIndex] is not JsonObject part)
                    continue;
                Func<string, Task<string>> Slot(
                    string kind,
                    string? path = null,
                    string? name = null,
                    string? callId = null
                ) => text => redactSlot(new(index, partIndex, kind, path, name, callId), text);
                await FieldAsync(part, "text", Slot("text"));
                await FieldAsync(part, "system", Slot("system"));
                if (part["functionCall"] is JsonObject call)
                {
                    var name = SessionWait.Text(call["name"]);
                    var callId = SessionWait.Text(call["id"]);
                    var parsed = SessionWait.Text(call["rawArgsText"]) is string raw
                        ? FunctionCallArguments.Parse(JsonValue.Create(raw))
                        : null;
                    if (
                        SessionWait.Text(call["argsParseError"]) is { Length: > 0 }
                        || parsed?.ArgsParseError is not null
                    )
                        await FieldAsync(
                            call,
                            "rawArgsText",
                            Slot("arguments", null, name, callId)
                        );
                    else if ((parsed?.Args ?? call["args"]) is JsonNode args)
                    {
                        var transformed = await StringsAsync(
                            args,
                            (path, text) => Slot("argument", path, name, callId)(text),
                            ""
                        );
                        call["args"] = transformed;
                        // Serializers prefer rawArgsText when present. Keep both forms in
                        // agreement after a substitution; otherwise keep the raw text as is.
                        if (
                            call.ContainsKey("rawArgsText")
                            && !JsonNode.DeepEquals(args, transformed)
                        )
                            call["rawArgsText"] = Serialize(transformed);
                    }
                }
                if (part["functionResponse"] is JsonObject response)
                    response["response"] = new JsonObject
                    {
                        ["output"] = await Slot(
                            "output",
                            null,
                            SessionWait.Text(response["name"]),
                            SessionWait.Text(response["tool_use_id"])
                        )(ToolResponseFormatting.Format(response["response"])),
                    };
            }
        }
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

    // `path` names the value inside the arguments (`command`, `items[0].name`).
    private static async Task<JsonNode?> StringsAsync(
        JsonNode? node,
        Func<string, string, Task<string>> transform,
        string path
    )
    {
        if (SessionWait.Text(node) is string text)
            return JsonValue.Create(await transform(path, text));
        if (node is JsonObject obj)
        {
            var copy = new JsonObject();
            foreach (var (key, value) in obj)
                copy[key] = await StringsAsync(
                    value,
                    transform,
                    path.Length == 0 ? key : path + "." + key
                );
            return copy;
        }
        if (node is JsonArray array)
        {
            var copy = new JsonArray();
            for (var index = 0; index < array.Count; index++)
                copy.Add(await StringsAsync(array[index], transform, path + "[" + index + "]"));
            return copy;
        }
        return node?.DeepClone();
    }

    private static JsonNode? RestoreStrings(JsonNode? node, TextRedactionScope scope)
    {
        if (SessionWait.Text(node) is string text)
            return JsonValue.Create(scope.Restore(text));
        if (node is JsonObject obj)
        {
            var copy = new JsonObject();
            foreach (var (key, value) in obj)
                copy[key] = RestoreStrings(value, scope);
            return copy;
        }
        if (node is JsonArray array)
            return new JsonArray(array.Select(child => RestoreStrings(child, scope)).ToArray());
        return node?.DeepClone();
    }

    // Restores this attempt's placeholders in ordinary text and structured arguments. Valid
    // raw argument text is re-serialized only when a placeholder was actually restored.
    internal static JsonObject RestoreMessage(JsonObject original, TextRedactionScope scope)
    {
        var message = (JsonObject)original.DeepClone();
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (SessionWait.Text(part["text"]) is string text)
                part["text"] = scope.Restore(text);
            if (part["functionCall"] is JsonObject call && call["args"] is JsonObject args)
            {
                var restored = RestoreStrings(args, scope);
                if (JsonNode.DeepEquals(args, restored))
                    continue;
                call["args"] = restored;
                if (
                    call.ContainsKey("rawArgsText")
                    && string.IsNullOrEmpty(SessionWait.Text(call["argsParseError"]))
                )
                    call["rawArgsText"] = Serialize(restored);
            }
        }
        return message;
    }

    // Whether restoring would change this function call's arguments.
    internal static bool Restores(JsonObject call, TextRedactionScope scope) =>
        call["args"] is JsonObject args && !JsonNode.DeepEquals(args, RestoreStrings(args, scope));

    internal static ResponsesStreamProgress RestoreProgress(
        ResponsesStreamProgress value,
        TextRedactionScope scope
    )
    {
        string? Arguments(string? raw)
        {
            if (raw is null)
                return null;
            try
            {
                var parsed = JsonNode.Parse(raw);
                var restored = RestoreStrings(parsed, scope);
                return JsonNode.DeepEquals(parsed, restored) ? raw : Serialize(restored);
            }
            catch (JsonException)
            {
                // Incomplete JSON cannot be restored safely as an argument object.
                return null;
            }
        }
        return value with
        {
            Text = scope.RestoreProgress(value.Text),
            Parts = value
                .Parts?.Select(part =>
                    part.Kind == "text" && part.Text is string text
                        ? part with
                        {
                            Text = scope.RestoreProgress(text),
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
