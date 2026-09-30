using System.Text;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

/// <summary>Only a path-level boundary within a dedicated experiment workspace, not an OS sandbox.</summary>
public sealed partial class WorkspaceTools : ITurnToolExecutor
{
    private const int MaxBytes = 1024 * 1024;
    private readonly string root;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    // The caller-approved model-facing definitions are intentionally kept verbatim.
    public static JsonArray Definitions()
    {
        var definitions = new JsonArray(
        new JsonObject
        {
            ["type"] = "function",
            ["name"] = "read",
            ["description"] = "Read a UTF-8 text file. Relative paths use this agent's workspace; absolute paths read an accessible local file. Files are limited to 1 MiB. Directories and symbolic links are not supported.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["properties"] = new JsonObject
                {
                    ["filePath"] = new JsonObject { ["type"] = "string", ["description"] = "Path to an existing file, relative to this agent's workspace or absolute on the local host." }
                },
                ["required"] = new JsonArray("filePath")
            },
            ["strict"] = false
        },
        new JsonObject
        {
            ["type"] = "function",
            ["name"] = "write",
            ["description"] = "Write UTF-8 text to a file in the configured tool workspace. The parent directory must already exist. Existing files are protected unless overwrite is true. Content is limited to 1 MiB; symbolic links are not supported.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = false,
                ["properties"] = new JsonObject
                {
                    ["filePath"] = new JsonObject { ["type"] = "string", ["description"] = "Destination path, relative to the tool workspace." },
                    ["content"] = new JsonObject { ["type"] = "string", ["description"] = "Complete UTF-8 text to write to the file." },
                    ["overwrite"] = new JsonObject { ["type"] = "boolean", ["description"] = "Allow replacement of an existing regular file. Defaults to false." }
                },
                ["required"] = new JsonArray("filePath", "content")
            },
            ["strict"] = false
        });
        definitions.Add(EditDefinition());
        definitions.Add(PatchDefinition());
        return definitions;
    }

    public WorkspaceTools(string root)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        this.root = Path.GetFullPath(root);
        Directory.CreateDirectory(this.root);
        if ((File.GetAttributes(this.root) & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("Workspace root cannot be a symbolic link.");
    }

    public async Task<JsonObject> ExecuteAsync(JsonObject functionCall, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var name = functionCall["name"]?.GetValue<string>();
        var args = functionCall["args"] as JsonObject;
        if (name is "edit" or "apply_patch")
            return await ExecuteEditPatchAsync(name, args, cancellationToken);
        if (name is not ("read" or "write")) return Error("unknown_tool", "Unsupported workspace tool.");
        if (args is null || args["filePath"] is not JsonValue pathValue || !pathValue.TryGetValue<string>(out var pathText))
            return Error("invalid_tool_arguments", "Invalid workspace tool arguments.");
        if ((name == "read" && args.Count != 1)
            || (name == "write" && (args.Count is < 2 or > 3
                || args["content"] is not JsonValue contentValue || !contentValue.TryGetValue<string>(out _)
                || (args.ContainsKey("overwrite") && (args["overwrite"] is not JsonValue overwriteValue
                    || !overwriteValue.TryGetValue<bool>(out _))))))
            return Error("invalid_tool_arguments", "Invalid workspace tool arguments.");
        string path;
        try { path = name == "read" && Path.IsPathRooted(pathText) ? ResolveAbsoluteRead(pathText) : Resolve(pathText, name == "write"); }
        catch (ArgumentException) { return Error("invalid_path", "Invalid path or symbolic link."); }
        catch (IOException) { return Error("tool_io_error", "Workspace I/O failed."); }
        catch (UnauthorizedAccessException) { return Error("tool_io_error", "Workspace access denied."); }
        try
        {
            if (name == "read")
            {
                if (!RegularFile(path)) return Error("not_file", "Regular file not found.");
                await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 8192, FileOptions.Asynchronous);
                if (stream.Length > MaxBytes) return Error("too_large", "File exceeds 1 MiB.");
                using var buffer = new MemoryStream();
                var chunk = new byte[8192];
                while (true)
                {
                    var count = await stream.ReadAsync(chunk.AsMemory(0, (int)Math.Min(chunk.Length, MaxBytes + 1 - buffer.Length)), cancellationToken);
                    if (count == 0) break;
                    buffer.Write(chunk, 0, count);
                    if (buffer.Length > MaxBytes) return Error("too_large", "File exceeds 1 MiB.");
                }
                try { return new JsonObject { ["output"] = StrictUtf8.GetString(buffer.ToArray()) }; }
                catch (DecoderFallbackException) { return Error("invalid_utf8", "File is not valid UTF-8."); }
            }
            var content = args!["content"]!.GetValue<string>();
            byte[] bytes;
            try { bytes = StrictUtf8.GetBytes(content); }
            catch (EncoderFallbackException) { return Error("invalid_utf8", "Content is not valid UTF-8."); }
            if (bytes.Length > MaxBytes) return Error("too_large", "Content exceeds 1 MiB.");
            var overwrite = args["overwrite"]?.GetValue<bool>() ?? false;
            if (!Directory.Exists(Path.GetDirectoryName(path))) return Error("missing_parent", "Parent directory does not exist.");
            if (Directory.Exists(path) || (File.Exists(path) && !overwrite)) return Error("file_exists", "File already exists.");
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                return Error("invalid_path", "Symbolic links are not supported.");
            var temp = Path.Combine(Path.GetDirectoryName(path)!, $".foxwarm-write-{Guid.NewGuid():N}");
            try
            {
                await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, FileOptions.Asynchronous))
                {
                    await stream.WriteAsync(bytes, cancellationToken);
                    await stream.FlushAsync(cancellationToken);
                }
                // Re-check before replacement; this remains a path boundary, not race-proof OS confinement.
                _ = Resolve(pathText, true);
                if (Directory.Exists(path) || (File.Exists(path) && !overwrite)) return Error("file_exists", "File already exists.");
                File.Move(temp, path, overwrite);
                return new JsonObject { ["output"] = "written" };
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        catch (OperationCanceledException) { throw; }
        catch (ArgumentException) { return Error("invalid_path", "Invalid path or symbolic link."); }
        catch (IOException) { return Error("tool_io_error", "Workspace I/O failed."); }
        catch (UnauthorizedAccessException) { return Error("tool_io_error", "Workspace access denied."); }
    }

    private static bool RegularFile(string path)
    {
        if (!File.Exists(path)) return false;
        if (!OperatingSystem.IsLinux()) return (File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.Device | FileAttributes.ReparsePoint)) == 0;
        // Linux statx has a fixed 256-byte ABI; only the mode/type field is needed.
        return Statx(-100, path, 0x100, 1, out var info) == 0 && (info.Mode & 0xf000) == 0x8000;
    }
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct FileTypeInfo { [FieldOffset(28)] internal ushort Mode; }
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, string path, int flags, uint mask, out FileTypeInfo info);

    private static string ResolveAbsoluteRead(string path)
    {
        if (path.Contains('\0')) throw new ArgumentException("Invalid path.");
        var absolute = Path.GetFullPath(path);
        var current = Path.GetPathRoot(absolute)!;
        foreach (var segment in absolute[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, segment);
            if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0
                || new FileInfo(current).LinkTarget is not null) throw new ArgumentException("Symbolic link.");
        }
        return absolute;
    }

    private string Resolve(string path, bool allowMissingLast)
    {
        if (string.IsNullOrWhiteSpace(path) || Path.IsPathRooted(path) || path.Contains('\\') || path.Contains(':')
            || path.Contains('\0')) throw new ArgumentException("Invalid path.");
        var segments = path.Split('/');
        if (segments.Any(segment => segment.Length == 0 || segment is "." or "..")) throw new ArgumentException("Invalid segment.");
        var current = root;
        for (var i = 0; i < segments.Length; i++)
        {
            current = Path.Combine(current, segments[i]);
            if (File.Exists(current) || Directory.Exists(current))
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("Symbolic link.");
                if (i < segments.Length - 1 && !Directory.Exists(current)) throw new ArgumentException("Non-directory component.");
                if (i == segments.Length - 1 && !File.Exists(current)) throw new ArgumentException("Non-file target.");
            }
            else if (new FileInfo(current).LinkTarget is not null) throw new ArgumentException("Dangling symbolic link.");
            else if (i < segments.Length - 1 || !allowMissingLast) throw new ArgumentException("Missing component.");
        }
        return current;
    }

    private static JsonObject Error(string kind, string message) => UnsupportedTurnToolExecutor.ToolError(kind, message);
}
