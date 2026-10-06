using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal static partial class UnifiedTools
{
    private static readonly string[] UnsupportedKeywords =
    [
        "$ref",
        "allOf",
        "patternProperties",
        "propertyNames",
        "dependentSchemas",
        "dependentRequired",
        "dependencies",
        "unevaluatedProperties",
        "minProperties",
        "maxProperties",
        "not",
        "if",
        "then",
        "else",
    ];

    private static string SchemaType(JsonNode? node, int depth)
    {
        if (node is not JsonObject schema || depth >= 4)
            return "unknown";
        var type = SessionWait.Text(schema["type"]);
        if (UnsupportedKeywords.Any(schema.ContainsKey))
            return
                type == "object"
                || schema["properties"] is not null
                || schema["patternProperties"] is not null
                ? "Record<string, unknown>"
                : "unknown";
        string Literal(JsonNode? value) =>
            value is JsonValue leaf && leaf.TryGetValue<string>(out var text)
                ? Quote(
                    string.Concat(text.EnumerateRunes().Take(100).Select(rune => rune.ToString()))
                )
            : value is null ? "null"
            : value is JsonValue ? value.ToJsonString()
            : "unknown";
        if (schema.ContainsKey("const"))
            return Literal(schema["const"]);
        if (schema["enum"] is JsonArray enumeration)
        {
            var members = enumeration.Take(12).Select(Literal).ToList();
            if (enumeration.Count > 12)
                members.Add("unknown");
            return members.Count == 0 ? "unknown" : string.Join(" | ", members);
        }
        if ((schema["oneOf"] ?? schema["anyOf"]) is JsonArray union)
        {
            var members = union.Take(8).Select(value => SchemaType(value, depth + 1)).ToList();
            if (union.Count > 8)
                members.Add("unknown");
            return members.Count == 0 ? "unknown" : string.Join(" | ", members.Distinct());
        }
        if (schema["type"] is JsonArray types)
        {
            var members = types
                .Take(8)
                .Select(value =>
                {
                    var copy = (JsonObject)schema.DeepClone();
                    copy["type"] = value?.DeepClone();
                    return SchemaType(copy, depth + 1);
                })
                .ToList();
            if (types.Count > 8)
                members.Add("unknown");
            return members.Count == 0 ? "unknown" : string.Join(" | ", members.Distinct());
        }
        if (type is "string" or "boolean" or "null")
            return type;
        if (type is "number" or "integer")
            return "number";
        if (type == "array")
            return "Array<" + SchemaType(schema["items"], depth + 1) + ">";
        if (
            type != "object"
            && schema["properties"] is null
            && schema["additionalProperties"] is null
        )
            return "unknown";
        var properties = schema["properties"] as JsonObject ?? new JsonObject();
        var requiredArray = schema["required"] as JsonArray ?? new JsonArray();
        if (requiredArray.Count > 100)
            return "Record<string, unknown> /* required constraints omitted */";
        var required = requiredArray
            .Select(value => SessionWait.Text(value) ?? value?.ToJsonString() ?? "null")
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var missing = required.Where(key => !properties.ContainsKey(key)).ToArray();
        var closed =
            schema["additionalProperties"] is JsonValue additional
            && additional.TryGetValue<bool>(out var flag)
            && !flag;
        if (closed && missing.Length > 0)
            return "never";
        var other = schema["additionalProperties"] is JsonObject otherSchema
            ? SchemaType(otherSchema, depth + 1)
            : "unknown";
        var entries = new List<(string Name, JsonNode? Schema, bool Other)>();
        if (properties.Count <= 20 && missing.Length == 0)
            entries.AddRange(properties.Select(pair => (pair.Key, pair.Value, false)));
        else
        {
            entries.AddRange(
                properties
                    .Where(pair => required.Contains(pair.Key, StringComparer.Ordinal))
                    .Select(pair => (pair.Key, pair.Value, false))
            );
            entries.AddRange(missing.Select(key => (key, schema["additionalProperties"], true)));
            entries.AddRange(
                properties
                    .Where(pair => !required.Contains(pair.Key, StringComparer.Ordinal))
                    .Select(pair => (pair.Key, pair.Value, false))
            );
        }
        if (entries.Count == 0 && !closed)
            return "Record<string, " + other + ">";
        var parts = new List<string>();
        var shown = entries.Take(20).ToArray();
        foreach (var entry in shown)
        {
            var name = Regex.IsMatch(
                entry.Name,
                "^[A-Za-z_$][A-Za-z0-9_$]*$",
                RegexOptions.CultureInvariant
            )
                ? entry.Name
                : Quote(entry.Name);
            var description = entry.Schema is JsonObject property
                ? SessionWait.Text(property["description"]) ?? ""
                : "";
            parts.Add(
                name
                    + (required.Contains(entry.Name, StringComparer.Ordinal) ? "" : "?")
                    + ": "
                    + (entry.Other ? other : SchemaType(entry.Schema, depth + 1))
                    + (description.Length > 0 ? " /* " + Comment(description, 240) + " */" : "")
                    + (entry.Other ? " /* required; other key */" : "")
                    + ";"
            );
        }
        var shownNames = shown.Select(entry => entry.Name).ToHashSet(StringComparer.Ordinal);
        var omittedRequired = required.Count(key => !shownNames.Contains(key));
        var omittedOptional = properties.Count(pair =>
            !required.Contains(pair.Key, StringComparer.Ordinal) && !shownNames.Contains(pair.Key)
        );
        if (omittedRequired > 0)
            parts.Add($"/* {omittedRequired} required keys omitted; constraint unknown */");
        if (omittedOptional > 0)
            parts.Add($"/* {omittedOptional} optional properties omitted */");
        if (!closed)
            parts.Add("/* other keys: " + other + " */");
        return "{ " + string.Join(' ', parts) + " }";
    }
}
