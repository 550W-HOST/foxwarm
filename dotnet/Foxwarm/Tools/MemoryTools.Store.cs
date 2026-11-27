using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

/// <summary>
/// The memory tools over an Agent store. A call means what it means over Agent folders: the
/// same path forms (a leading `memory/` or `/`, `.` and `..` resolved inside the memory
/// directory), the same results and, for every condition file mode has, the same error text,
/// with the memory-relative path where file mode's .NET texts name a physical path. Only
/// conditions file mode lacks use the store's texts: an invalid store path, a file changed
/// since an edit read it, and the store's limits.
/// </summary>
internal static partial class MemoryTools
{
    private static readonly StringComparer ListingOrder = StringComparer.Create(
        CultureInfo.GetCultureInfo("en-US"),
        false
    );

    private static Task<JsonObject> StoreExecuteAsync(
        IAgentStore store,
        SessionOwner owner,
        SessionManager manager,
        string name,
        JsonObject args,
        CancellationToken token
    ) =>
        name switch
        {
            "read_memory" => StoreReadAsync(store, owner, manager, args, token),
            "write_memory" => StoreWriteAsync(store, owner, manager, args, token),
            "edit_memory" => StoreEditAsync(store, owner, manager, args, token),
            "delete_memory" => StoreDeleteAsync(store, owner, manager, args, token),
            "apply_patch_memory" => StorePatchAsync(store, owner, manager, args, token),
            _ => throw new InvalidDataException("Unknown memory tool."),
        };

    private static IReadOnlyList<AuthorizationPath> StoreAuthorizationFacts(
        SessionManager manager,
        SessionOwner owner,
        string name,
        JsonObject args
    )
    {
        var agent = TargetAgent(manager, owner, args);
        AuthorizationPath Fact(string arg, string raw, bool leadingSlash) =>
            new(
                arg,
                raw,
                AgentStorePaths.Fact(agent, StorePathOf(raw, leadingSlash).Store),
                AgentStorePaths.Endpoint
            );
        if (name == "apply_patch_memory")
            return WorkspacePatch
                .Parse(Text(args, "input"))
                .Select(operation => Fact("input", operation.Path, false))
                .ToArray();
        return [Fact("filePath", Text(args, "filePath"), true)];
    }

    // A memory path: the store path (`memory/<relative>`) and the display path (relative to
    // the memory directory), resolved as PathOf resolves it in a folder.
    private readonly record struct MemoryPath(string Store, string Display);

    private static MemoryPath StorePathOf(string raw, bool normalizeLeadingSlash)
    {
        var trimmed = raw.Trim();
        if (!normalizeLeadingSlash && (trimmed.StartsWith('/') || Path.IsPathRooted(trimmed)))
            throw new InvalidDataException(
                "Patch file paths must be relative to the Agent's memory directory."
            );
        var relative = normalizeLeadingSlash ? trimmed.TrimStart('/', '\\') : trimmed;
        if (relative.Equals("memory", StringComparison.Ordinal))
            throw new InvalidDataException(
                "filePath must include a path below the Agent's memory directory."
            );
        if (
            relative.StartsWith("memory/", StringComparison.Ordinal)
            || relative.StartsWith("memory\\", StringComparison.Ordinal)
        )
            relative = relative[7..].TrimStart('/', '\\');
        if (relative.Length == 0 || relative == "." || relative == "..")
            throw new InvalidDataException(
                "filePath must point to a file inside the Agent's memory directory."
            );
        // As Path.GetFullPath inside the memory directory: empty and `.` segments vanish, `..`
        // removes the previous one, and leaving the directory is traversal.
        var segments = new List<string>();
        foreach (var segment in relative.Split('/'))
        {
            if (segment is "" or ".")
                continue;
            if (segment == "..")
            {
                if (segments.Count == 0)
                    throw new InvalidDataException(
                        "Path traversal detected: cannot access files outside the Agent's memory directory."
                    );
                segments.RemoveAt(segments.Count - 1);
                continue;
            }
            segments.Add(segment);
        }
        // A path that resolves to the memory directory itself names it, as in a folder.
        if (segments.Count == 0)
            return new("memory", ".");
        var display = string.Join('/', segments);
        var store = "memory/" + display;
        AgentFilePaths.Require(store);
        return new(store, display);
    }

    private static MemoryPath StorePath(JsonObject args, bool normalizeLeadingSlash = true) =>
        StorePathOf(Text(args, "filePath"), normalizeLeadingSlash);

    private static async Task<JsonObject> StoreReadAsync(
        IAgentStore store,
        SessionOwner owner,
        SessionManager manager,
        JsonObject args,
        CancellationToken token
    )
    {
        var agent = TargetAgent(manager, owner, args);
        var path = StorePath(args);
        var stat = store.Stat(agent, path.Store);
        if (stat is null)
            throw new FileNotFoundException("Memory file or directory not found.", path.Display);
        double? Number(string key) =>
            args[key] is null
                ? null
                : SessionWait.Number(args[key])
                    ?? throw new InvalidDataException(key + " must be a number.");
        if (stat.IsDirectory)
        {
            var entries = store
                .List(agent, path.Store)
                .Select(entry =>
                {
                    var modified = entry.IsDirectory
                        ? store.Stat(agent, path.Store + "/" + entry.Name)?.LastWriteUtc
                        : entry.LastWriteUtc;
                    return new TargetFileStat(
                        entry.IsDirectory ? "directory" : "file",
                        entry.IsDirectory ? 0 : entry.Length ?? 0,
                        modified is { } time ? new DateTimeOffset(time).ToUnixTimeMilliseconds() : 0,
                        entry.Name
                    );
                })
                .OrderBy(entry => entry.Name, ListingOrder)
                .ToArray();
            return new JsonObject
            {
                ["output"] = FileToolCore.FormatDirectory(
                    path.Display,
                    Number("startLine"),
                    Number("endLine"),
                    entries
                ),
            };
        }
        var content = (await store.ReadAsync(agent, path.Store, token)).Bytes;
        return new JsonObject
        {
            ["output"] = await FileToolCore.ReadContent(
                path.Display,
                path.Display,
                content.Length,
                Number("startLine"),
                Number("endLine"),
                (offset, count) =>
                {
                    var start = (int)Math.Min(offset, content.Length);
                    return Task.FromResult(content[start..Math.Min(content.Length, start + count)]);
                }
            ),
        };
    }

    private static async Task<JsonObject> StoreWriteAsync(
        IAgentStore store,
        SessionOwner owner,
        SessionManager manager,
        JsonObject args,
        CancellationToken token
    )
    {
        var agent = TargetAgent(manager, owner, args);
        var path = StorePath(args);
        var exists = new InvalidDataException(
            $"Memory file already exists: {path.Display}. `ctl memory write` only creates new files; use `ctl memory edit` to modify an existing memory file."
        );
        if (store.Stat(agent, path.Store) is not null)
            throw exists;
        var content = Text(args, "content");
        RequireStoreParents(store, agent, path);
        try
        {
            await store.WriteAsync(agent, path.Store, Encoding.UTF8.GetBytes(content), 0, token);
        }
        catch (AgentFileConflictException)
        {
            throw exists;
        }
        return new JsonObject
        {
            ["output"] = "Memory file created: " + path.Display + Named(args, agent),
        };
    }

    private static async Task<JsonObject> StoreEditAsync(
        IAgentStore store,
        SessionOwner owner,
        SessionManager manager,
        JsonObject args,
        CancellationToken token
    )
    {
        var agent = TargetAgent(manager, owner, args);
        var path = StorePath(args);
        var oldText = Text(args, "oldText");
        var newText = Text(args, "newText");
        var (current, generation) = await StoreReadTextAsync(store, agent, path, token);
        var count = Count(current, oldText);
        if (count == 0)
            throw new InvalidDataException(
                "Could not find oldText in file. Make sure whitespace matches exactly."
            );
        if (count > 1)
            throw new InvalidDataException(
                $"Found {count} occurrences of oldText in file. Make oldText more specific."
            );
        var updated =
            oldText.Length == 0
                ? newText + current
                : current.Replace(oldText, newText, StringComparison.Ordinal);
        await store.WriteAsync(agent, path.Store, Encoding.UTF8.GetBytes(updated), generation, token);
        return new JsonObject
        {
            ["output"] = "Memory file edited: " + path.Display + Named(args, agent),
        };
    }

    private static async Task<JsonObject> StoreDeleteAsync(
        IAgentStore store,
        SessionOwner owner,
        SessionManager manager,
        JsonObject args,
        CancellationToken token
    )
    {
        var agent = TargetAgent(manager, owner, args);
        var path = StorePath(args);
        token.ThrowIfCancellationRequested();
        var stat = store.Stat(agent, path.Store);
        if (stat is null)
            throw new FileNotFoundException("Memory file not found.", path.Display);
        if (stat.IsDirectory)
            throw new InvalidDataException("Cannot delete directory: " + path.Display);
        try
        {
            // Only the file observed: a replacement or a directory in its place stays.
            await store.DeleteAsync(agent, path.Store, false, stat.Generation, token);
        }
        catch (FileNotFoundException)
        {
            throw new FileNotFoundException("Memory file not found.", path.Display);
        }
        return new JsonObject
        {
            ["output"] = "Deleted memory file `" + path.Display + "`" + Named(args, agent),
        };
    }

    private static async Task<JsonObject> StorePatchAsync(
        IAgentStore store,
        SessionOwner owner,
        SessionManager manager,
        JsonObject args,
        CancellationToken token
    )
    {
        var agent = TargetAgent(manager, owner, args);
        var operations = WorkspacePatch.Parse(Text(args, "input"));
        var summaries = new List<string>();
        try
        {
            foreach (var operation in operations)
            {
                var path = StorePathOf(operation.Path, false);
                if (operation.Action == "add")
                {
                    var exists = new InvalidDataException(
                        "Cannot add file that already exists: " + operation.Path
                    );
                    if (store.Stat(agent, path.Store) is not null)
                        throw exists;
                    RequireStoreParents(store, agent, path);
                    try
                    {
                        await store.WriteAsync(
                            agent,
                            path.Store,
                            Encoding.UTF8.GetBytes(string.Join('\n', operation.Lines)),
                            0,
                            token
                        );
                    }
                    catch (AgentFileConflictException)
                    {
                        throw exists;
                    }
                }
                else if (operation.Action == "delete")
                {
                    var missing = new InvalidDataException(
                        "Cannot delete missing file: " + operation.Path
                    );
                    if (store.Stat(agent, path.Store) is not { IsDirectory: false } observed)
                        throw missing;
                    try
                    {
                        await store.DeleteAsync(agent, path.Store, false, observed.Generation, token);
                    }
                    catch (FileNotFoundException)
                    {
                        throw missing;
                    }
                }
                else
                {
                    var (current, generation) = await StoreReadTextAsync(store, agent, path, token);
                    var updated = WorkspacePatch.Update(current, operation.Lines, operation.Path);
                    await store.WriteAsync(
                        agent,
                        path.Store,
                        Encoding.UTF8.GetBytes(updated),
                        generation,
                        token
                    );
                }
                summaries.Add(WorkspacePatch.Summary(operation));
            }
            return new JsonObject
            {
                ["output"] =
                    "Patch applied successfully"
                    + Named(args, agent)
                    + ".\n"
                    + string.Join('\n', summaries.Select(item => "- " + item)),
            };
        }
        catch (Exception error)
            when (error
                    is InvalidDataException
                        or IOException
                        or UnauthorizedAccessException
                        or ArgumentException
            )
        {
            throw PatchFailure(error, operations, summaries);
        }
    }

    // A memory file's text, strictly UTF-8 as ReadText reads it, with the generation it has.
    // A missing file and a directory fail with the texts File.ReadAllBytesAsync gives in a
    // folder, naming the memory path.
    private static async Task<(string Text, long Generation)> StoreReadTextAsync(
        IAgentStore store,
        string agent,
        MemoryPath path,
        CancellationToken token
    )
    {
        AgentFileContent content;
        try
        {
            content = await store.ReadAsync(agent, path.Store, token);
        }
        catch (FileNotFoundException)
        {
            // A missing directory on the way is a missing part of the path, as in a folder.
            if (AgentFilePaths.Ancestors(path.Store).Any(ancestor => store.Stat(agent, ancestor) is null))
                throw new DirectoryNotFoundException($"Could not find a part of the path '{path.Display}'.");
            throw new FileNotFoundException($"Could not find file '{path.Display}'.", path.Display);
        }
        catch (IOException) when (store.Stat(agent, path.Store) is { IsDirectory: true })
        {
            throw new UnauthorizedAccessException($"Access to the path '{path.Display}' is denied.");
        }
        return (StrictUtf8.GetString(content.Bytes), content.Generation);
    }

    // A parent that is a file, which EnsureParents reports in a folder.
    private static void RequireStoreParents(IAgentStore store, string agent, MemoryPath path)
    {
        foreach (var ancestor in AgentFilePaths.Ancestors(path.Store))
            if (store.Stat(agent, ancestor) is { IsDirectory: false })
                throw new InvalidDataException("Memory parent path is not a directory.");
    }
}
