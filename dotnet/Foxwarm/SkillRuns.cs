using System.Collections;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm;

// The validated `run` block of a runnable skill: an entry ToolScript inside the skill directory,
// a one-line effect for the catalog, default mode and budget, and the schema of its args
// (docs/code-index/units/host-runtime.md#runnable-skills).
internal sealed record SkillRun(
    string Entry,
    string Effect,
    string Mode,
    double? TimeoutSecs,
    JsonObject Args
);

// A runnable skill's entry as read for one run: UTF-8 source and the hash of its bytes.
internal sealed record SkillEntry(SkillInfo Info, SkillRun Run, string Path, string Code, string Sha256)
{
    // Run-record provenance.
    internal JsonObject Provenance() =>
        new()
        {
            ["name"] = Info.Name,
            ["sourceType"] = Info.SourceType,
            ["agent"] = Info.SourceAgent,
            ["entry"] = Run.Entry,
            ["sha256"] = Sha256,
        };
}

internal sealed partial class Skills
{
    internal const int MaxEffectLength = 200;

    private static readonly string[] RunKeys = ["entry", "effect", "mode", "timeoutSecs", "args"];

    private static readonly string[] SchemaKeys =
    [
        "type",
        "properties",
        "required",
        "enum",
        "items",
        "description",
        "additionalProperties",
    ];

    private static readonly string[] SchemaTypes =
    [
        "object",
        "string",
        "integer",
        "number",
        "boolean",
        "array",
        "null",
    ];

    // Reads a runnable skill's entry through the skill subsystem: the same resolution as load,
    // then the entry, revalidated inside the skill directory. Never a Node `read`.
    internal async Task<SkillEntry> ReadEntryAsync(
        string name,
        string agent,
        CancellationToken token = default
    )
    {
        var info = await RunnableAsync(name, agent);
        var run = info.Run!;
        var path = EntryPath(info.Directory, run.Entry);
        var bytes = await File.ReadAllBytesAsync(path, token);
        string code;
        try
        {
            code = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw new InvalidDataException(
                $"The entry `{run.Entry}` of skill `{info.Name}` is not valid UTF-8."
            );
        }
        if (code.StartsWith('\uFEFF'))
            code = code[1..];
        if (string.IsNullOrWhiteSpace(code))
            throw new InvalidDataException(
                $"The entry `{run.Entry}` of skill `{info.Name}` is empty."
            );
        return new SkillEntry(
            info,
            run,
            path,
            code,
            Convert.ToHexStringLower(SHA256.HashData(bytes))
        );
    }

    // The skill `name` resolves to, which must be runnable; Run is set on the result.
    internal async Task<SkillInfo> RunnableAsync(string name, string agent)
    {
        var info = await FindAsync(name, agent, false, Task.FromResult);
        if (info.Run is null)
            throw new InvalidDataException(
                info.RunError is { } reason
                    ? $"Skill `{info.Name}` has an invalid `run` block: {reason}"
                    : $"Skill `{info.Name}` has no runnable entry; load it with `ctl skill load {info.Name}`."
            );
        return info;
    }

    // (null, null) without a `run` block; (null, reason) for an invalid one, which leaves the
    // skill loadable but not runnable.
    private static (SkillRun? Run, string? Error) Run(string content, string directory)
    {
        var match = FrontMatter().Match(content);
        if (!match.Success)
            return (null, null);
        object? data;
        try
        {
            data = FrontMatterYaml.Parse(match.Groups[1].Value);
        }
        catch (YamlDotNet.Core.YamlException)
        {
            return (null, null);
        }
        if (data is not IDictionary map || !map.Contains("run"))
            return (null, null);
        try
        {
            return (ParseRun(map["run"], directory), null);
        }
        catch (InvalidDataException error)
        {
            return (null, error.Message);
        }
    }

    internal static SkillRun ParseRun(object? raw, string directory)
    {
        if (raw is not IDictionary run)
            throw new InvalidDataException("`run` must be a mapping.");
        foreach (var key in run.Keys)
            if (key is not string name || !RunKeys.Contains(name))
                throw new InvalidDataException(
                    $"`run.{key}` is not a recognized field; use {string.Join(", ", RunKeys)}."
                );
        if (run["entry"] is not string entry || entry.Trim().Length == 0)
            throw new InvalidDataException(
                "`run.entry` is required: the entry script, relative to the skill directory."
            );
        entry = entry.Trim();
        _ = EntryPath(directory, entry);
        if (run["effect"] is not string effect || effect.Trim().Length == 0)
            throw new InvalidDataException(
                "`run.effect` is required: one line saying what running the skill does."
            );
        effect = effect.Trim();
        if (effect.Contains('\n') || effect.Contains('\r') || effect.Length > MaxEffectLength)
            throw new InvalidDataException(
                $"`run.effect` must be one line of at most {MaxEffectLength} characters."
            );
        var mode = run["mode"] switch
        {
            null => "foreground",
            string text when text.Trim() is "foreground" or "background" => text.Trim(),
            _ => throw new InvalidDataException("`run.mode` must be foreground or background."),
        };
        double? timeout = null;
        if (run["timeoutSecs"] is { } rawTimeout)
        {
            if (
                !double.TryParse(
                    Convert.ToString(rawTimeout, CultureInfo.InvariantCulture),
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out var seconds
                )
                || !double.IsFinite(seconds)
                || seconds <= 0
            )
                throw new InvalidDataException("`run.timeoutSecs` must be a positive number.");
            timeout = seconds;
        }
        var args = run.Contains("args")
            ? Schema(run["args"], "run.args")
            : new JsonObject
            {
                ["type"] = "object",
                ["properties"] = new JsonObject(),
                ["additionalProperties"] = false,
            };
        if (SessionText(args["type"]) != "object")
            throw new InvalidDataException("`run.args` must have type: object.");
        return new SkillRun(entry, effect, mode, timeout, args);
    }

    // The entry's full path: relative, no `.`/`..` segments, every component below the skill
    // directory a real directory or regular file, never a reparse point.
    internal static string EntryPath(string directory, string entry)
    {
        var segments = entry.Split('/');
        if (
            entry.Contains('\\')
            || entry.Contains(':')
            || Path.IsPathRooted(entry)
            || segments.Any(segment => segment.Length == 0 || segment is "." or "..")
        )
            throw new InvalidDataException(
                $"`run.entry` `{entry}` must be a relative path inside the skill directory."
            );
        var current = directory;
        for (var index = 0; index < segments.Length; index++)
        {
            current = Path.Combine(current, segments[index]);
            var last = index == segments.Length - 1;
            var exists = last ? File.Exists(current) : Directory.Exists(current);
            if (!exists || (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException(
                    $"`run.entry` `{entry}` is not a regular file in the skill directory."
                );
        }
        return current;
    }

    private static string? SessionText(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    // Converts the frontmatter subset of JSON Schema. Frontmatter keeps untagged scalars as
    // strings, so booleans and enum values are converted by the declared type here.
    private static JsonObject Schema(object? raw, string where)
    {
        if (raw is not IDictionary map)
            throw new InvalidDataException($"`{where}` must be a mapping.");
        var schema = new JsonObject();
        foreach (DictionaryEntry item in map)
        {
            if (item.Key is not string key || !SchemaKeys.Contains(key))
                throw new InvalidDataException(
                    $"`{where}.{item.Key}` is not supported; use {string.Join(", ", SchemaKeys)}."
                );
            var at = $"{where}.{key}";
            switch (key)
            {
                case "type":
                    if (item.Value is not string type || !SchemaTypes.Contains(type))
                        throw new InvalidDataException(
                            $"`{at}` must be one of {string.Join(", ", SchemaTypes)}."
                        );
                    schema[key] = type;
                    break;
                case "description":
                    schema[key] =
                        item.Value as string
                        ?? throw new InvalidDataException($"`{at}` must be text.");
                    break;
                case "properties":
                    if (item.Value is not IDictionary properties)
                        throw new InvalidDataException($"`{at}` must be a mapping.");
                    var converted = new JsonObject();
                    foreach (DictionaryEntry property in properties)
                    {
                        if (property.Key is not string name || name.Length == 0)
                            throw new InvalidDataException($"`{at}` has an invalid name.");
                        converted[name] = Schema(property.Value, $"{at}.{name}");
                    }
                    schema[key] = converted;
                    break;
                case "required":
                    if (item.Value is not IList required || required.Cast<object?>().Any(name => name is not string))
                        throw new InvalidDataException($"`{at}` must be a list of names.");
                    schema[key] = new JsonArray(
                        required.Cast<string>().Select(name => (JsonNode?)name).ToArray()
                    );
                    break;
                case "enum":
                    if (
                        item.Value is not IList values
                        || values.Count == 0
                        || values.Cast<object?>().Any(value => value is IDictionary or IList)
                    )
                        throw new InvalidDataException($"`{at}` must be a nonempty list of values.");
                    schema[key] = new JsonArray(
                        values.Cast<object?>().Select(value => (JsonNode?)Scalar(value)).ToArray()
                    );
                    break;
                case "items":
                    schema[key] = Schema(item.Value, at);
                    break;
                case "additionalProperties":
                    schema[key] = Convert.ToString(item.Value, CultureInfo.InvariantCulture) switch
                    {
                        "true" or "True" => true,
                        "false" or "False" => false,
                        _ => throw new InvalidDataException($"`{at}` must be true or false."),
                    };
                    break;
            }
        }
        if (schema["enum"] is JsonArray options && SessionText(schema["type"]) is { } declared)
        {
            var typed = new JsonArray();
            foreach (var option in options)
                typed.Add(Typed(option, declared, where));
            schema["enum"] = typed;
        }
        if (schema["required"] is JsonArray names)
            foreach (var name in names)
                if (schema["properties"] is not JsonObject declaredProperties || !declaredProperties.ContainsKey(SessionText(name)!))
                    throw new InvalidDataException(
                        $"`{where}.required` names `{SessionText(name)}`, which is not in its properties."
                    );
        return schema;
    }

    private static JsonValue? Scalar(object? value) =>
        value is null ? null : JsonValue.Create(Convert.ToString(value, CultureInfo.InvariantCulture));

    private static JsonNode? Typed(JsonNode? option, string type, string where)
    {
        var text = SessionText(option);
        switch (type)
        {
            case "integer" when long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var integer):
                return integer;
            case "number" when double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number):
                return number;
            case "boolean" when text is "true" or "false":
                return text == "true";
            case "string":
                return option?.DeepClone();
            case "null" when text is null or "null" or "~":
                return null;
            default:
                throw new InvalidDataException($"`{where}.enum` value `{text}` is not a {type}.");
        }
    }

    // Checks run arguments against the skill's schema before any run exists. Errors name the
    // field and what it expects.
    internal static void ValidateArgs(JsonObject schema, JsonNode? value) =>
        CheckArgs(schema, value, "args");

    private static void CheckArgs(JsonObject schema, JsonNode? value, string path)
    {
        if (SessionText(schema["type"]) is { } type && !HasType(type, value))
            throw new InvalidDataException(
                $"`{path}` must be {Article(type)}, not {Describe(value)}."
            );
        if (
            schema["enum"] is JsonArray options
            && !options.Any(option => JsonNode.DeepEquals(option, value))
        )
            throw new InvalidDataException(
                $"`{path}` must be one of {string.Join(", ", options.Select(Show))}."
            );
        if (value is JsonObject map)
        {
            var properties = schema["properties"] as JsonObject;
            if (schema["required"] is JsonArray required)
                foreach (var name in required.Select(SessionText).OfType<string>())
                    if (!map.ContainsKey(name))
                        throw new InvalidDataException($"`{path}.{name}` is required.");
            var closed =
                schema["additionalProperties"] is JsonValue open
                && open.TryGetValue<bool>(out var allowed)
                && !allowed;
            foreach (var (name, child) in map)
            {
                if (properties?[name] is JsonObject property)
                    CheckArgs(property, child, $"{path}.{name}");
                else if (closed)
                    throw new InvalidDataException(
                        properties is { Count: > 0 }
                            ? $"`{path}.{name}` is not an argument here; use {string.Join(", ", properties.Select(item => item.Key))}."
                            : $"`{path}.{name}` is not an argument here; it takes none."
                    );
            }
        }
        if (value is JsonArray list && schema["items"] is JsonObject items)
            for (var index = 0; index < list.Count; index++)
                CheckArgs(items, list[index], $"{path}[{index}]");
    }

    private static bool HasType(string type, JsonNode? value)
    {
        var kind = value?.GetValueKind() ?? JsonValueKind.Null;
        return type switch
        {
            "object" => kind == JsonValueKind.Object,
            "array" => kind == JsonValueKind.Array,
            "string" => kind == JsonValueKind.String,
            "boolean" => kind is JsonValueKind.True or JsonValueKind.False,
            "null" => kind == JsonValueKind.Null,
            "number" => kind == JsonValueKind.Number,
            // Read from the JSON text: a value node may hold any CLR numeric type.
            "integer" => kind == JsonValueKind.Number
                && double.TryParse(
                    value!.ToJsonString(),
                    NumberStyles.Float,
                    CultureInfo.InvariantCulture,
                    out var number
                )
                && double.IsFinite(number)
                && Math.Floor(number) == number,
            _ => true,
        };
    }

    private static string Article(string type) =>
        type switch
        {
            "object" => "an object",
            "array" => "an array",
            "integer" => "an integer",
            "null" => "null",
            _ => "a " + type,
        };

    private static string Describe(JsonNode? value) =>
        (value?.GetValueKind() ?? JsonValueKind.Null) switch
        {
            JsonValueKind.Object => "an object",
            JsonValueKind.Array => "an array",
            JsonValueKind.String => "a string",
            JsonValueKind.Number => "a number",
            JsonValueKind.True or JsonValueKind.False => "a boolean",
            _ => "null",
        };

    private static string Show(JsonNode? value) => value is null ? "null" : value.ToJsonString();
}
