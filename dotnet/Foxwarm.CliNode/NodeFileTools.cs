using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Tools;

namespace Foxwarm.CliNode;

internal sealed class NodeFileTools(NodePaths paths)
{
    internal async Task<JsonObject> Execute(
        string tool,
        JsonObject? args,
        string? agent,
        string? cwd,
        bool programmatic
    )
    {
        if (tool == "get_default_cwd")
            return new JsonObject { ["output"] = paths.StartupDirectory };
        // External Source contexts do not request programmatic capture or resolved-path sidecars.
        programmatic &= agent is not null;
        args ??= new JsonObject();
        var resolved = new JsonArray();
        string? activePath = null;
        string Resolve(string raw)
        {
            var path = paths.Resolve(raw, agent, cwd);
            activePath = path;
            resolved.Add((JsonNode)new JsonObject { ["raw"] = raw, ["resolved"] = path });
            return path;
        }
        JsonObject result;
        try
        {
            switch (tool)
            {
                case "read":
                {
                    var raw = RequiredPath(args, tool);
                    var path = Resolve(raw);
                    string? mime = null;
                    if (!Directory.Exists(path) && FileToolCore.NativeSize(path) > 0)
                    {
                        await using var stream = File.OpenRead(path);
                        var header = new byte[RasterImageMime.HeaderBytes];
                        var count = await stream.ReadAsync(header);
                        mime = RasterImageMime.Detect(header.AsSpan(0, count));
                    }
                    if (mime is not null)
                    {
                        var bytes = await File.ReadAllBytesAsync(path);
                        result = new JsonObject
                        {
                            ["output"] = "[Image loaded: " + raw + "]",
                            ["mimeType"] = mime,
                            ["sizeBytes"] = bytes.LongLength,
                            ["inlineData"] = new JsonObject
                            {
                                ["data"] = Convert.ToBase64String(bytes),
                                ["mimeType"] = mime,
                            },
                        };
                    }
                    else
                    {
                        JsonObject? data = null;
                        var output = await FileToolCore.Read(
                            path,
                            raw,
                            JsNumber(args["startLine"]),
                            JsNumber(args["endLine"]),
                            CancellationToken.None,
                            programmatic ? value => data = value : null
                        );
                        result = data ?? new JsonObject();
                        result["output"] = output;
                    }
                    break;
                }
                case "write":
                {
                    var content =
                        Text(args["content"])
                        ?? throw new InvalidDataException("write requires string content");
                    var raw = Text(args["filePath"]);
                    var path = Resolve(raw!);
                    await Write(
                        path,
                        content,
                        Flag(args, "overwrite"),
                        Flag(args, "createDirs"),
                        raw!
                    );
                    result = new JsonObject { ["output"] = "File written successfully" };
                    break;
                }
                case "edit":
                {
                    var raw = RequiredPath(args, tool);
                    var oldText = Text(args["oldText"]);
                    var newText = Text(args["newText"]);
                    if (oldText is null || newText is null)
                        throw new InvalidDataException(
                            "Edit tool requires oldText and newText. Use apply_patch for patch-style edits."
                        );
                    var path = Resolve(raw);
                    if (Directory.Exists(path))
                        throw new NodeFileException(
                            "EISDIR",
                            "EISDIR: illegal operation on a directory, read"
                        );
                    var content = Encoding.UTF8.GetString(await File.ReadAllBytesAsync(path));
                    // Source edit uses JS replacement-string tokens; Main's callers intentionally use literals.
                    var replacement = Replacement(content, oldText, newText);
                    var (occurrences, updated) = ExactReplacement.Apply(
                        content,
                        oldText,
                        replacement
                    );
                    if (occurrences == 0)
                        throw new InvalidDataException(
                            "Could not find oldText in file. Make sure whitespace matches exactly."
                        );
                    if (occurrences != 1)
                        throw new InvalidDataException(
                            $"Found {occurrences} occurrences of oldText in file. Edit tool only replaces once. Please make oldText more specific to match exactly one location."
                        );
                    await FileToolCore.WriteBytes(
                        path,
                        Encoding.UTF8.GetBytes(updated!),
                        true,
                        default
                    );
                    result = new JsonObject { ["output"] = "File edited successfully" };
                    break;
                }
                case "apply_patch":
                {
                    var input = Text(args["input"]);
                    if (string.IsNullOrEmpty(input))
                        throw new InvalidDataException("apply_patch requires input string.");
                    var operations = WorkspacePatch.Parse(input);
                    var summaries = new List<string>();
                    for (var index = 0; index < operations.Length; index++)
                    {
                        var operation = operations[index];
                        var path = Resolve(operation.Path);
                        try
                        {
                            var exists = Exists(path);
                            if (operation.Action == "update")
                            {
                                if (!exists)
                                    throw new InvalidDataException(
                                        "Cannot update missing file: " + operation.Path
                                    );
                                if (Directory.Exists(path))
                                    throw new NodeFileException(
                                        "EISDIR",
                                        "EISDIR: illegal operation on a directory, read"
                                    );
                                var content = Encoding.UTF8.GetString(
                                    await File.ReadAllBytesAsync(path)
                                );
                                var updated = WorkspacePatch.Update(
                                    content,
                                    operation.Lines,
                                    operation.Path
                                );
                                await FileToolCore.WriteBytes(
                                    path,
                                    Encoding.UTF8.GetBytes(updated),
                                    true,
                                    default
                                );
                            }
                            else if (operation.Action == "add")
                            {
                                if (exists)
                                    throw new InvalidDataException(
                                        "Cannot add file that already exists: " + operation.Path
                                    );
                                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                                var content = string.Join('\n', operation.Lines);
                                await FileToolCore.WriteBytes(
                                    path,
                                    Encoding.UTF8.GetBytes(content),
                                    true,
                                    default
                                );
                            }
                            else
                            {
                                if (!exists)
                                    throw new InvalidDataException(
                                        "Cannot delete missing file: " + operation.Path
                                    );
                                Remove(path);
                            }
                            summaries.Add(
                                operation.Action switch
                                {
                                    "add" => $"Added {operation.Path} (+{operation.Lines.Length})",
                                    "delete" => $"Deleted {operation.Path}",
                                    _ =>
                                        $"Updated {operation.Path} (+{operation.Lines.Count(line => line.StartsWith('+'))} -{operation.Lines.Count(line => line.StartsWith('-'))})",
                                }
                            );
                        }
                        catch (Exception error)
                        {
                            var succeeded =
                                summaries.Count > 0
                                    ? "\nOperations already applied (these changes are already on disk):\n"
                                        + string.Join('\n', summaries.Select(line => "- " + line))
                                        + "\n"
                                    : "";
                            var remaining = operations.Length - index - 1;
                            throw new InvalidDataException(
                                error.Message
                                    + succeeded
                                    + (
                                        remaining > 0
                                            ? $"\n{remaining} remaining operation(s) were not applied."
                                            : ""
                                    )
                            );
                        }
                    }
                    result = new JsonObject
                    {
                        ["output"] =
                            "Patch applied successfully.\n"
                            + string.Join('\n', summaries.Select(line => "- " + line)),
                    };
                    break;
                }
                default:
                    throw new InvalidDataException($"Tool `{tool}` not found");
            }
            if (agent is not null && resolved.Count > 0)
                result["__foxwarmResolvedToolPaths"] = resolved;
            return result;
        }
        catch (IOException error)
            when (activePath is not null
                && error is FileNotFoundException or DirectoryNotFoundException
            )
        {
            // .NET stat/open exceptions conflate ENOENT and ENOTDIR; retain the native error code.
            for (
                var parent = Path.GetDirectoryName(activePath);
                parent is not null;
                parent = Path.GetDirectoryName(parent)
            )
                if (File.Exists(parent))
                    throw new NodeFileException("ENOTDIR", "Not a directory: " + parent);
            throw;
        }
    }

    internal static string? Text(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    internal static bool Flag(JsonObject value, string key) =>
        value[key] is JsonValue flag && flag.TryGetValue<bool>(out var boolean) && boolean;

    private static string RequiredPath(JsonObject args, string tool)
    {
        var path = Text(args["filePath"]);
        if (string.IsNullOrWhiteSpace(path))
            throw new InvalidDataException(tool + " requires filePath.");
        return path;
    }

    // Optional Source line bounds use Number(value), including numeric strings and booleans.
    private static double? JsNumber(JsonNode? node)
    {
        if (node is null)
            return null;
        if (node is JsonValue value && value.TryGetValue<bool>(out var flag))
            return flag ? 1 : 0;
        var text = Text(node) ?? node.ToJsonString();
        if (string.IsNullOrWhiteSpace(text))
            return 0;
        return double.TryParse(
            text,
            NumberStyles.Float,
            CultureInfo.InvariantCulture,
            out var number
        )
            ? number
            : null;
    }

    internal static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

    private static async Task Write(
        string path,
        string content,
        bool overwrite,
        bool createDirs,
        string display
    )
    {
        if (createDirs)
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (Directory.Exists(path))
        {
            if (overwrite)
                throw new NodeFileException(
                    "EISDIR",
                    "EISDIR: illegal operation on a directory, open '" + path + "'"
                );
            throw new InvalidDataException(
                $"File already exists: {display}. Use overwrite=true to overwrite, or use edit tool to modify existing file."
            );
        }
        try
        {
            if (
                !await FileToolCore.WriteBytes(
                    path,
                    Encoding.UTF8.GetBytes(content),
                    overwrite,
                    default
                )
            )
                throw new InvalidDataException(
                    $"File already exists: {display}. Use overwrite=true to overwrite, or use edit tool to modify existing file."
                );
        }
        catch (IOException) when (!createDirs)
        {
            var parent = Path.GetDirectoryName(path)!;
            var chain = new Stack<string>();
            while (Path.GetDirectoryName(parent) is string previous && previous != parent)
            {
                chain.Push(parent);
                parent = previous;
            }
            while (chain.TryPop(out var item))
            {
                if (File.Exists(item))
                    throw new InvalidDataException("Parent path is not a directory: " + item + ".");
                if (!Directory.Exists(item))
                    throw new InvalidDataException(
                        "Parent directory does not exist: "
                            + item
                            + ". write does not create parent directories by default. Retry with createDirs=true to create missing parent directories."
                    );
            }
            throw;
        }
    }

    internal static void Remove(string path)
    {
        if (new FileInfo(path).LinkTarget is not null)
            File.Delete(path);
        else if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
        else
            File.Delete(path);
    }

    private static string Replacement(string text, string search, string replacement)
    {
        var index = text.IndexOf(search, StringComparison.Ordinal);
        if (index < 0 || !replacement.Contains('$'))
            return replacement;
        var result = new StringBuilder();
        for (var i = 0; i < replacement.Length; i++)
        {
            if (replacement[i] == '$' && i + 1 < replacement.Length)
            {
                var token = replacement[i + 1];
                var expanded = token switch
                {
                    '$' => "$",
                    '&' => search,
                    '`' => text[..index],
                    '\'' => text[(index + search.Length)..],
                    _ => null,
                };
                if (expanded is not null)
                {
                    result.Append(expanded);
                    i++;
                    continue;
                }
            }
            result.Append(replacement[i]);
        }
        return result.ToString();
    }
}

internal sealed class NodeFileException(string code, string message) : IOException(message)
{
    internal string Code { get; } = code;
}
