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
        var agent = owner.Agent;
        if (name == "apply_patch_memory")
        {
            var input = Text(args, "input"); return WorkspacePatch.Parse(input).Select(operation =>
            {
                var path = PathOf(manager, owner, new JsonObject { ["filePath"] = operation.Path }, agent);
                return new AuthorizationPath("input", operation.Path, AuthorizationPaths.CanonicalPotential(path));
            }).ToArray();
        }
        var raw = Text(args, "filePath"); var resolved = PathOf(manager, owner, args, agent);
        return [new AuthorizationPath("filePath", raw, AuthorizationPaths.CanonicalPotential(resolved))];
    }

    private static string PathOf(SessionManager manager, SessionOwner owner, JsonObject args, string? agent = null)
    {
        var raw = Text(args, "filePath");
        var relative = raw.Trim().TrimStart('/', '\\');
        if (relative.StartsWith("memory/", StringComparison.Ordinal) || relative.StartsWith("memory\\", StringComparison.Ordinal)) relative = relative[7..];
        if (relative.Length == 0 || relative == "." || relative == "..") throw new InvalidDataException("filePath must point to a file inside the current agent memory directory.");
        var root = AuthorizationPaths.CanonicalPotential(manager.MemoryDirectory(agent ?? owner.Agent));
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
        var agent = owner.Agent; var path = PathOf(manager, owner, args, agent); if (!File.Exists(path) && !Directory.Exists(path)) throw new FileNotFoundException("Memory file or directory not found.", path);
        double? Number(string key) => args[key] is null ? null : SessionWait.Number(args[key]) ?? throw new InvalidDataException(key + " must be a number.");
        return new JsonObject { ["output"] = await FileToolCore.Read(path, Path.GetRelativePath(manager.MemoryDirectory(agent), path), Number("startLine"), Number("endLine"), token) };
    }

    private static async Task<JsonObject> WriteAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    {
        var agent = owner.Agent; var path = PathOf(manager, owner, args, agent); if (File.Exists(path) || Directory.Exists(path)) throw new InvalidDataException($"Memory file already exists: {Display(manager, agent, path)}. write_memory only creates new files; use edit_memory to modify an existing memory file.");
        var content = Text(args, "content"); var parent = Path.GetDirectoryName(path)!; EnsureParents(parent); Directory.CreateDirectory(parent); EnsureParents(parent);
        await FileToolCore.WriteAtomic(path, content, false, () => EnsureParents(parent), token); return new JsonObject { ["output"] = "Memory file created: " + Display(manager, agent, path) };
    }

    private static async Task<JsonObject> EditAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    {
        var agent = owner.Agent; var path = PathOf(manager, owner, args, agent); var oldText = Text(args, "oldText"); var newText = Text(args, "newText"); var current = await ReadText(path, token); var count = Count(current, oldText);
        if (count == 0) throw new InvalidDataException("Could not find oldText in file. Make sure whitespace matches exactly."); if (count > 1) throw new InvalidDataException($"Found {count} occurrences of oldText in file. Make oldText more specific.");
        var updated = oldText.Length == 0 ? newText + current : current.Replace(oldText, newText, StringComparison.Ordinal);
        await WriteAtomic(path, updated, token); return new JsonObject { ["output"] = "Memory file edited: " + Display(manager, agent, path) };
    }

    private static Task<JsonObject> DeleteAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    { var agent = owner.Agent; var path = PathOf(manager, owner, args, agent); token.ThrowIfCancellationRequested(); if (!File.Exists(path)) throw new FileNotFoundException("Memory file not found.", path); if (Directory.Exists(path)) throw new InvalidDataException("Cannot delete directory: " + Display(manager, agent, path)); File.Delete(path); return Task.FromResult(new JsonObject { ["output"] = "Deleted memory file `" + Display(manager, agent, path) + "`" }); }

    private static async Task<JsonObject> PatchAsync(SessionOwner owner, SessionManager manager, JsonObject args, CancellationToken token)
    {
        var agent = owner.Agent; var input = Text(args, "input"); var operations = WorkspacePatch.Parse(input); var summaries = new List<string>();
        try
        {
        foreach (var operation in operations)
        {
            var patchArgs = new JsonObject { ["filePath"] = operation.Path }; var path = PathOf(manager, owner, patchArgs, agent);
            if (operation.Action == "add") { if (File.Exists(path) || Directory.Exists(path)) throw new InvalidDataException("Cannot add file that already exists: " + operation.Path); var parent = Path.GetDirectoryName(path)!; EnsureParents(parent); Directory.CreateDirectory(parent); EnsureParents(parent); await WriteAtomic(path, string.Join('\n', operation.Lines), token); }
            else if (operation.Action == "delete") { if (!File.Exists(path)) throw new InvalidDataException("Cannot delete missing file: " + operation.Path); File.Delete(path); }
            else { var updated = WorkspacePatch.Update(await ReadText(path, token), operation.Lines, operation.Path); await WriteAtomic(path, updated, token); }
            summaries.Add(WorkspacePatch.Summary(operation));
        }
        return new JsonObject { ["output"] = "Patch applied successfully.\n" + string.Join('\n', summaries.Select(item => "- " + item)) };
        }
        catch (Exception error) when (error is InvalidDataException or IOException or UnauthorizedAccessException or FileNotFoundException)
        {
            var applied = summaries.Count == 0 ? "No operations were applied." : "Applied operations:\n" + string.Join('\n', summaries.Select(item => "- " + item));
            var remaining = operations.Skip(summaries.Count).Select(WorkspacePatch.Summary).ToArray();
            var pending = remaining.Length == 0 ? "No operations remain." : "Remaining operations:\n" + string.Join('\n', remaining.Select(item => "- " + item));
            throw new InvalidDataException($"{error.Message}\n{applied}\n{pending}", error);
        }
    }

    private static async Task<string> ReadText(string path, CancellationToken token) => StrictUtf8.GetString(await File.ReadAllBytesAsync(path, token));
    private static async Task WriteAtomic(string path, string content, CancellationToken token) { await FileToolCore.WriteAtomic(path, content, true, () => EnsureParents(Path.GetDirectoryName(path)!), token); }
    private static void EnsureParents(string path)
    {
        var root = AuthorizationPaths.CanonicalPotential(path); if (root != path) throw new InvalidDataException("Memory parent path cannot be a symbolic link.");
        var current = Path.GetPathRoot(path)!; foreach (var part in path[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        { current = Path.Combine(current, part); if (File.Exists(current) && !Directory.Exists(current)) throw new InvalidDataException("Memory parent path is not a directory."); if (Directory.Exists(current) && ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0 || AuthorizationPaths.CanonicalPotential(current) != current)) throw new InvalidDataException("Memory parent path cannot be a symbolic link."); }
    }
    private static string Display(SessionManager manager, string agent, string path) => Path.GetRelativePath(manager.MemoryDirectory(agent), path).Replace(Path.DirectorySeparatorChar, '/');
    private static string Text(JsonObject args, string key) => SessionWait.Text(args[key]) ?? throw new InvalidDataException(key + " must be a string.");
    private static int Count(string text, string value) { if (value.Length == 0) return text.Length + 1; var count = 0; for (var i = 0; (i = text.IndexOf(value, i, StringComparison.Ordinal)) >= 0; i += value.Length) count++; return count; }
}