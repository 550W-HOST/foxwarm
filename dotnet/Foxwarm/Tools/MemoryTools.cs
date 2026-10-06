using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal static class MemoryTools
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static Task<JsonObject> ExecuteAsync(SessionOwner owner, SessionManager manager, string name, JsonObject args, CancellationToken token)
        => name switch
        {
            "read_memory" => ReadAsync(owner, manager, args, token),
            "write_memory" => WriteAsync(owner, manager, args, token),
            "edit_memory" => EditAsync(owner, manager, args, token),
            "delete_memory" => DeleteAsync(owner, manager, args, token),
            "apply_patch_memory" => PatchAsync(owner, manager, args, token),
            _ => throw new InvalidDataException("Unknown memory tool.")
        };

    internal static IReadOnlyList<AuthorizationPath> AuthorizationFacts(SessionManager manager, SessionOwner owner, string name, JsonObject args)
    {
        if (name == "apply_patch_memory")
        {
            var input = Text(args, "input"); return WorkspacePatch.Parse(input).Select(operation =>
            {
                var path = PathOf(manager, owner, new JsonObject { ["filePath"] = operation.Path });
                return new AuthorizationPath("input", operation.Path, AuthorizationPaths.CanonicalPotential(path));
            }).ToArray();
        }
        var raw = Text(args, "filePath"); var resolved = PathOf(manager, owner, args);
        return [new AuthorizationPath("filePath", raw, AuthorizationPaths.CanonicalPotential(resolved))];
    }

    private static string PathOf(SessionManager manager, SessionOwner owner, JsonObject args)
    {
        var raw = Text(args, "filePath");
        if (Path.IsPathRooted(raw)) throw new InvalidDataException("Memory tools require a path relative to the current agent memory/ directory.");
        var relative = raw.Trim().TrimStart('/', '\\');
        if (relative.StartsWith("memory/", StringComparison.OrdinalIgnoreCase) || relative.StartsWith("memory\\", StringComparison.OrdinalIgnoreCase)) relative = relative[7..];
        if (relative.Length == 0 || relative == "." || relative == "..") throw new InvalidDataException("filePath must point to a file inside the current agent memory directory.");
        var root = AuthorizationPaths.CanonicalPotential(manager.MemoryDirectory(owner.Agent));
        var path = Path.GetFullPath(Path.Combine(root, relative));
        if (path != root && !path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) throw new InvalidDataException("Path traversal detected: cannot access files outside the current agent memory directory.");
        if (File.Exists(path) || Directory.Exists(path))
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0 || AuthorizationPaths.CanonicalPotential(path) != path)
                throw new InvalidDataException("Memory paths cannot be symbolic links.");
        }
        return path;
    }

    private static async Task<JsonObject> ReadAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    {
        var path = PathOf(manager, owner, args); if (!File.Exists(path) && !Directory.Exists(path)) throw new FileNotFoundException("Memory file or directory not found.", path);
        double? Number(string key) => args[key] is null ? null : SessionWait.Number(args[key]) ?? throw new InvalidDataException(key + " must be a number.");
        return new JsonObject { ["output"] = await FileToolCore.Read(path, Path.GetRelativePath(manager.MemoryDirectory(owner.Agent), path), Number("startLine"), Number("endLine"), token) };
    }

    private static async Task<JsonObject> WriteAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    {
        var path = PathOf(manager, owner, args); if (File.Exists(path) || Directory.Exists(path)) throw new InvalidDataException($"Memory file already exists: {Display(manager, owner, path)}. write_memory only creates new files; use edit_memory to modify an existing memory file.");
        var content = Text(args, "content"); var parent = Path.GetDirectoryName(path)!; EnsureParents(parent); Directory.CreateDirectory(parent); EnsureParents(parent);
        await FileToolCore.WriteAtomic(path, content, false, () => EnsureParents(parent), token); return new JsonObject { ["output"] = "Memory file created: " + Display(manager, owner, path) };
    }

    private static async Task<JsonObject> EditAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    {
        var path = PathOf(manager, owner, args); var oldText = Text(args, "oldText"); var newText = Text(args, "newText"); var current = await ReadText(path, token); var count = Count(current, oldText);
        if (count == 0) throw new InvalidDataException("Could not find oldText in file. Make sure whitespace matches exactly."); if (count > 1) throw new InvalidDataException($"Found {count} occurrences of oldText in file. Make oldText more specific.");
        await WriteAtomic(path, current.Replace(oldText, newText, StringComparison.Ordinal), token); return new JsonObject { ["output"] = "Memory file edited: " + Display(manager, owner, path) };
    }

    private static Task<JsonObject> DeleteAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    { var path = PathOf(manager, owner, args); token.ThrowIfCancellationRequested(); if (Directory.Exists(path)) throw new InvalidDataException("Cannot delete directory: " + Display(manager, owner, path)); File.Delete(path); return Task.FromResult(new JsonObject { ["output"] = "Deleted memory file `" + Display(manager, owner, path) + "`" }); }

    private static async Task<JsonObject> PatchAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    {
        var input = Text(args, "input"); var operations = WorkspacePatch.Parse(input); var summaries = new List<string>();
        foreach (var operation in operations)
        {
            var patchArgs = new JsonObject { ["filePath"] = operation.Path }; var path = PathOf(manager, owner, patchArgs);
            if (operation.Action == "add") { if (File.Exists(path) || Directory.Exists(path)) throw new InvalidDataException("Cannot add file that already exists: " + operation.Path); Directory.CreateDirectory(Path.GetDirectoryName(path)!); await WriteAtomic(path, string.Join('\n', operation.Lines), token); }
            else if (operation.Action == "delete") { if (!File.Exists(path)) throw new InvalidDataException("Cannot delete missing file: " + operation.Path); File.Delete(path); }
            else { var updated = WorkspacePatch.Update(await ReadText(path, token), operation.Lines, operation.Path); await WriteAtomic(path, updated, token); }
            summaries.Add(WorkspacePatch.Summary(operation));
        }
        return new JsonObject { ["output"] = "Patch applied successfully.\n" + string.Join('\n', summaries.Select(item => "- " + item)) };
    }

    private static async Task<string> ReadText(string path, CancellationToken token) => StrictUtf8.GetString(await File.ReadAllBytesAsync(path, token));
    private static async Task WriteAtomic(string path, string content, CancellationToken token) { if (StrictUtf8.GetByteCount(content) > 1024 * 1024) throw new InvalidDataException("File exceeds 1 MiB."); await FileToolCore.WriteAtomic(path, content, true, () => EnsureParents(Path.GetDirectoryName(path)!), token); }
    private static void EnsureParents(string path)
    {
        var root = AuthorizationPaths.CanonicalPotential(path); if (root != path) throw new InvalidDataException("Memory parent path cannot be a symbolic link.");
        var current = Path.GetPathRoot(path)!; foreach (var part in path[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        { current = Path.Combine(current, part); if (File.Exists(current) && !Directory.Exists(current)) throw new InvalidDataException("Memory parent path is not a directory."); if (Directory.Exists(current) && ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0 || AuthorizationPaths.CanonicalPotential(current) != current)) throw new InvalidDataException("Memory parent path cannot be a symbolic link."); }
    }
    private static string Display(SessionManager manager, SessionOwner owner, string path) => Path.GetRelativePath(manager.MemoryDirectory(owner.Agent), path).Replace(Path.DirectorySeparatorChar, '/');
    private static string Text(JsonObject args, string key) => SessionWait.Text(args[key]) ?? throw new InvalidDataException(key + " must be a string.");
    private static int Count(string text, string value) { if (value.Length == 0) return text.Length + 1; var count = 0; for (var i = 0; (i = text.IndexOf(value, i, StringComparison.Ordinal)) >= 0; i += value.Length) count++; return count; }
}