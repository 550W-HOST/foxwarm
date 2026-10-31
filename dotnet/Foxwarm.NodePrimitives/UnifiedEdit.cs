using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal sealed record TextEdit(string OldText, string NewText, bool ReplaceAll);

internal sealed record UnifiedEdit(string? FilePath, string? Patch, TextEdit[] Edits)
{
    internal static UnifiedEdit Parse(JsonObject? args)
    {
        if (args is null)
            throw new InvalidDataException("edit requires arguments.");
        if (args.ContainsKey("apply_patch"))
        {
            if (args.Count != 1 || Text(args["apply_patch"]) is not { Length: > 0 } patch)
                throw new InvalidDataException(
                    "edit apply_patch requires nonempty patch text and cannot be combined with replacement arguments."
                );
            return new(null, patch, []);
        }
        if (Text(args["filePath"]) is not string path || string.IsNullOrWhiteSpace(path))
            throw new InvalidDataException("edit requires filePath.");
        if (args.ContainsKey("edits"))
        {
            if (
                args.Any(pair => pair.Key is not ("filePath" or "edits"))
                || args["edits"] is not JsonArray { Count: > 0 } edits
            )
                throw new InvalidDataException(
                    "edit requires a nonempty edits array without single-replacement arguments."
                );
            return new(path, null, edits.Select(ParseItem).ToArray());
        }
        if (
            args.Any(pair => pair.Key is not ("filePath" or "oldText" or "newText" or "replaceAll"))
        )
            throw new InvalidDataException("Invalid edit arguments.");
        var item = (JsonObject)args.DeepClone();
        item.Remove("filePath");
        return new(path, null, [ParseItem(item)]);
    }

    private static string? Text(JsonNode? value) =>
        value is JsonValue scalar && scalar.TryGetValue<string>(out var text) ? text : null;

    private static TextEdit ParseItem(JsonNode? raw)
    {
        if (
            raw is not JsonObject item
            || item.Any(pair => pair.Key is not ("oldText" or "newText" or "replaceAll"))
            || Text(item["oldText"]) is not { Length: > 0 } oldText
            || Text(item["newText"]) is not string newText
        )
            throw new InvalidDataException(
                "Each edit requires nonempty oldText, string newText and optional boolean replaceAll."
            );
        var all = false;
        if (
            item.ContainsKey("replaceAll")
            && (item["replaceAll"] is not JsonValue flag || !flag.TryGetValue<bool>(out all))
        )
            throw new InvalidDataException("replaceAll must be a boolean.");
        return new(oldText, newText, all);
    }

    internal string Apply(string content)
    {
        var ranges = new List<(int Start, int End, string Text)>();
        foreach (var edit in Edits)
        {
            var count = 0;
            for (
                var start = 0;
                (start = content.IndexOf(edit.OldText, start, StringComparison.Ordinal)) >= 0;
                start += edit.OldText.Length
            )
            {
                ranges.Add((start, start + edit.OldText.Length, edit.NewText));
                count++;
            }
            if (count == 0)
                throw new InvalidDataException(
                    "Could not find oldText in file. Make sure whitespace matches exactly."
                );
            if (!edit.ReplaceAll && count != 1)
                throw new InvalidDataException(
                    $"Found {count} occurrences of oldText in file. Make oldText more specific or use replaceAll."
                );
        }
        ranges.Sort((a, b) => a.Start.CompareTo(b.Start));
        var result = new StringBuilder();
        var cursor = 0;
        foreach (var range in ranges)
        {
            if (range.Start < cursor)
                throw new InvalidDataException("Edit entries overlap in the original file.");
            result.Append(content.AsSpan(cursor, range.Start - cursor));
            result.Append(range.Text);
            cursor = range.End;
        }
        result.Append(content.AsSpan(cursor));
        return result.ToString();
    }

    internal const string Description =
        "Edit files using exact text replacements or a patch. For one replacement, supply filePath, oldText and newText. For multiple replacements in one file, supply filePath and edits; all entries match the original content and must not overlap. Alternatively, supply apply_patch to add, modify or delete files using patch text. Use only one form per call.";

    internal static JsonObject Parameters(string pathDescription)
    {
        static JsonObject Field(string type, string description) =>
            new() { ["type"] = type, ["description"] = description };
        var item = new JsonObject
        {
            ["oldText"] = Field(
                "string",
                "Exact text to replace. Must be nonempty and match once unless replaceAll is true."
            ),
            ["newText"] = Field(
                "string",
                "Replacement text. Use an empty string to delete the matched text."
            ),
            ["replaceAll"] = Field(
                "boolean",
                "Replace every non-overlapping occurrence of oldText. Defaults to false."
            ),
        };
        item["oldText"]!["minLength"] = 1;
        return new JsonObject
        {
            ["type"] = "object",
            ["additionalProperties"] = false,
            ["properties"] = new JsonObject
            {
                ["filePath"] = Field("string", pathDescription),
                ["oldText"] = item["oldText"]!.DeepClone(),
                ["newText"] = item["newText"]!.DeepClone(),
                ["replaceAll"] = item["replaceAll"]!.DeepClone(),
                ["edits"] = new JsonObject
                {
                    ["type"] = "array",
                    ["minItems"] = 1,
                    ["description"] =
                        "Replacements in one file, all matched against its original content. Entries must not overlap.",
                    ["items"] = new JsonObject
                    {
                        ["type"] = "object",
                        ["additionalProperties"] = false,
                        ["properties"] = item,
                        ["required"] = new JsonArray("oldText", "newText"),
                    },
                },
                ["apply_patch"] = Field(
                    "string",
                    "Patch text enclosed in *** Begin Patch and *** End Patch. Use *** Update File:, *** Add File: or *** Delete File: headers. Update sections use space-prefixed context, - deletions, + additions and @@ anchors. Paths follow this Node's path rules. Do not combine with filePath or replacement arguments."
                ),
            },
        };
    }

    internal static JsonArray ProjectTools(JsonArray tools) =>
        new(
            tools
                .OfType<JsonObject>()
                .Where(tool => Text(tool["name"]) != "apply_patch")
                .Select(tool =>
                {
                    var projected = (JsonObject)tool.DeepClone();
                    if (Text(tool["name"]) == "edit")
                    {
                        projected["description"] = Description;
                        projected["parameters"] = Parameters(
                            Text(tool["parameters"]?["properties"]?["filePath"]?["description"])
                                ?? ""
                        );
                    }
                    return (JsonNode?)projected;
                })
                .ToArray()
        );
}
