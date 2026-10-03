using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

public sealed partial class WorkspaceTools
{
    private async Task<JsonObject> ExecuteEditPatchAsync(string name, JsonObject? args, CancellationToken ct)
    {
        try
        {
            if (name == "edit")
            {
                if (args is null || args.Count != 3 || !Text(args, "filePath", out var file)
                    || !Text(args, "oldText", out var oldText) || !Text(args, "newText", out var newText))
                    return Error("invalid_tool_arguments", "edit requires filePath, oldText and newText strings.");
                var path = ResolvePatchPath(file, false);
                var content = await ReadPatchFileAsync(path, ct);
                var occurrences = oldText.Length == 0 ? content.Length + 1 : CountOccurrences(content, oldText);
                if (occurrences == 0) return Error("edit_failed", "Could not find oldText in file. Make sure whitespace matches exactly.");
                if (occurrences > 1) return Error("edit_failed", $"Found {occurrences} occurrences of oldText in file. Make oldText more specific.");
                var updated = oldText.Length == 0 ? newText : content.Replace(oldText, newText, StringComparison.Ordinal);
                await WritePatchFileAsync(path, updated, true, ct);
                ReportPaths((file, path));
                return new JsonObject { ["output"] = "File edited successfully" };
            }
            if (args is null || args.Count != 1 || !Text(args, "input", out var input) || input.Length == 0)
                return Error("invalid_tool_arguments", "apply_patch requires input string.");
            PatchOperation[] operations;
            try { operations = WorkspacePatch.Parse(input); }
            catch (InvalidDataException error) { return Error("patch_failed", error.Message); }
            // Syntax/path expansion of every header precedes effects; filesystem failures retain partial application.
            try { foreach (var operation in operations) _ = ResolvePatchPath(operation.Path, true); }
            catch (ArgumentException) { return Error("invalid_path", "Invalid patch path."); }
            var applied = new List<string>();
            for (var index = 0; index < operations.Length; index++)
            {
                var operation = operations[index];
                try
                {
                    var path = ResolvePatchPath(operation.Path, operation.Action == "add");
                    if (operation.Action == "add")
                    {
                        if (File.Exists(path) || Directory.Exists(path)) throw new InvalidDataException($"Cannot add file that already exists: {operation.Path}");
                        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                        // Parent components created in this operation must still be ordinary directories.
                        path = ResolvePatchPath(operation.Path, true);
                        await WritePatchFileAsync(path, string.Join('\n', operation.Lines), false, ct);
                    }
                    else if (operation.Action == "delete")
                    {
                        _ = await ReadPatchFileAsync(path, ct);
                        File.Delete(path);
                    }
                    else
                    {
                        var content = await ReadPatchFileAsync(path, ct);
                        var updated = WorkspacePatch.Update(content, operation.Lines, operation.Path);
                        await WritePatchFileAsync(path, updated, true, ct);
                    }
                    applied.Add(WorkspacePatch.Summary(operation));
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException or InvalidDataException or DecoderFallbackException or EncoderFallbackException)
                {
                    var completed = applied.Count == 0 ? "" : "\nOperations already applied (these changes are already on disk):\n" + string.Join("\n", applied.Select(value => "- " + value)) + "\n";
                    var remaining = operations.Length - index - 1;
                    return Error("patch_failed", error.Message + completed + (remaining == 0 ? "" : $"\n{remaining} remaining operation(s) were not applied."));
                }
            }
            ReportPaths(operations.Select(operation => (operation.Path, ResolvePatchPath(operation.Path, true))).ToArray());
            return new JsonObject { ["output"] = "Patch applied successfully.\n" + string.Join("\n", applied.Select(value => "- " + value)) };
        }
        catch (OperationCanceledException) { throw; }
        catch (ArgumentException) { return Error("invalid_path", "Invalid path."); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidDataException or DecoderFallbackException or EncoderFallbackException)
        { return Error("tool_io_error", error.Message); }
    }

    private static bool Text(JsonObject args, string key, out string value)
    {
        value = "";
        return args[key] is JsonValue scalar && scalar.TryGetValue<string>(out value!);
    }

    private static int CountOccurrences(string text, string needle)
    {
        var count = 0;
        for (var i = 0; (i = text.IndexOf(needle, i, StringComparison.Ordinal)) >= 0; i += needle.Length) count++;
        return count;
    }

    private string ResolvePatchPath(string text, bool allowMissing) => Paths.FilePath(text);

    private static async Task<string> ReadPatchFileAsync(string path, CancellationToken ct)
    {
        if (!RegularFile(path))
            throw new InvalidDataException($"Regular file not found: {path}");
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 8192, FileOptions.Asynchronous);
        if (stream.Length > MaxBytes) throw new InvalidDataException("File exceeds 1 MiB.");
        using var buffer = new MemoryStream();
        var bytes = new byte[8192];
        int n;
        while ((n = await stream.ReadAsync(bytes, ct)) > 0)
        {
            if (buffer.Length + n > MaxBytes) throw new InvalidDataException("File exceeds 1 MiB.");
            buffer.Write(bytes, 0, n);
        }
        return StrictUtf8.GetString(buffer.ToArray());
    }

    private async Task WritePatchFileAsync(string path, string content, bool overwrite, CancellationToken ct)
    {
        path = AuthorizationPaths.CanonicalPotential(path);
        var bytes = StrictUtf8.GetBytes(content);
        if (bytes.Length > MaxBytes) throw new InvalidDataException("Resulting file exceeds 1 MiB.");
        var temp = Path.Combine(Path.GetDirectoryName(path)!, $".foxwarm-edit-{Guid.NewGuid():N}");
        try
        {
            await File.WriteAllBytesAsync(temp, bytes, ct);
            File.Move(temp, path, overwrite);
        }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
}
