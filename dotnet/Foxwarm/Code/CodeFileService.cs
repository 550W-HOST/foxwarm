using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Foxwarm.Code;

internal sealed class CodeServiceException(
    string code,
    string message,
    int? status = null,
    Exception? inner = null
) : Exception(message, inner)
{
    internal string Code { get; } = code;
    internal int Status { get; } =
        status
        ?? code switch
        {
            "FileNotFound" => 404,
            "FileExists" => 409,
            "NoPermissions" => 403,
            "Unavailable" => 503,
            "PayloadTooLarge" => 413,
            "InvalidNode"
            or "InvalidPath"
            or "FileNotADirectory"
            or "FileIsADirectory"
            or "UnsupportedNode" => 400,
            "GitError" or "InvalidCommit" => 422,
            _ => 500,
        };

    internal static Exception FileError(Exception error) =>
        error switch
        {
            CodeServiceException => error,
            UnauthorizedAccessException => new CodeServiceException(
                "NoPermissions",
                error.Message,
                inner: error
            ),
            FileNotFoundException or DirectoryNotFoundException => new CodeServiceException(
                "FileNotFound",
                error.Message,
                inner: error
            ),
            _ => new CodeServiceException("Unknown", error.Message, inner: error),
        };
}

internal static class CodeFileService
{
    internal const long MaxFileBytes = 50L * 1024 * 1024;

    internal static string Node(string? value)
    {
        var id = string.IsNullOrWhiteSpace(value) ? "master" : value.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9._-]+$"))
            throw new CodeServiceException("InvalidNode", "Invalid node id.");
        return id;
    }

    internal static string PathValue(string? value)
    {
        if (
            string.IsNullOrWhiteSpace(value)
            || !value.Trim().StartsWith('/')
            || value.Contains('\0')
        )
            throw new CodeServiceException(
                "InvalidPath",
                "An absolute filesystem path is required."
            );
        var parts = new List<string>();
        foreach (var part in value.Trim().Split('/'))
        {
            if (part is "" or ".")
                continue;
            if (part == "..")
            {
                if (parts.Count > 0)
                    parts.RemoveAt(parts.Count - 1);
            }
            else
                parts.Add(part);
        }
        return "/" + string.Join('/', parts);
    }

    internal static bool Bool(JsonNode? value) =>
        value switch
        {
            JsonValue node when node.TryGetValue<bool>(out var flag) => flag,
            JsonValue node when node.TryGetValue<double>(out var number) => number != 0,
            JsonValue node when node.TryGetValue<string>(out var text) => text.Trim()
                .ToLowerInvariant()
                is "1"
                    or "true"
                    or "yes",
            _ => false,
        };

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct LinuxStat
    {
        [FieldOffset(28)]
        internal ushort Mode;

        [FieldOffset(40)]
        internal ulong Size;

        [FieldOffset(96)]
        internal long ChangeSeconds;

        [FieldOffset(104)]
        internal uint ChangeNanoseconds;

        [FieldOffset(112)]
        internal long ModifiedSeconds;

        [FieldOffset(120)]
        internal uint ModifiedNanoseconds;
    }

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(
        int directory,
        string path,
        int flags,
        uint mask,
        out LinuxStat info
    );

    [DllImport("libc", EntryPoint = "rename", SetLastError = true)]
    private static extern int RenameNative(string oldPath, string newPath);

    private static CodeServiceException NativeError(string path)
    {
        var errno = Marshal.GetLastPInvokeError();
        var code = errno switch
        {
            2 or 20 => "FileNotFound",
            13 or 1 => "NoPermissions",
            17 => "FileExists",
            _ => "Unknown",
        };
        return new(code, new System.ComponentModel.Win32Exception(errno).Message + ": " + path);
    }

    private static LinuxStat Stat(string path, bool link)
    {
        if (!OperatingSystem.IsLinux())
            throw new CodeServiceException(
                "Unavailable",
                "Code filesystem services require a POSIX Main host."
            );
        if (Statx(-100, path, link ? 0x100 : 0, 0x7ff, out var info) != 0)
            throw NativeError(path);
        return info;
    }

    internal static JsonObject StatFile(string path)
    {
        var link = Stat(path, true);
        var actual = (link.Mode & 0xf000) == 0xa000 ? Stat(path, false) : link;
        var type = (actual.Mode & 0xf000) switch
        {
            0x8000 => 1,
            0x4000 => 2,
            _ => 0,
        };
        if ((link.Mode & 0xf000) == 0xa000)
            type |= 64;
        return new()
        {
            ["type"] = type,
            ["ctime"] = actual.ChangeSeconds * 1000d + actual.ChangeNanoseconds / 1_000_000d,
            ["mtime"] = actual.ModifiedSeconds * 1000d + actual.ModifiedNanoseconds / 1_000_000d,
            ["size"] = actual.Size,
        };
    }

    private static bool DirectoryStat(JsonObject stat) => (stat["type"]!.GetValue<int>() & 2) != 0;

    private static bool Exists(string path)
    {
        try
        {
            _ = StatFile(path);
            return true;
        }
        catch (CodeServiceException error) when (error.Code == "FileNotFound")
        {
            return false;
        }
    }

    private static void Parent(string path)
    {
        if (!DirectoryStat(StatFile(Path.GetDirectoryName(path) ?? Path.GetPathRoot(path)!)))
            throw new CodeServiceException("FileNotADirectory", "Parent path is not a directory.");
    }

    internal static JsonObject ReadDirectory(string path)
    {
        if (!DirectoryStat(StatFile(path)))
            throw new CodeServiceException("FileNotADirectory", "Path is not a directory.");
        var entries = new JsonArray();
        foreach (var child in Directory.EnumerateFileSystemEntries(path))
        {
            var type = 0;
            try
            {
                type = StatFile(child)["type"]!.GetValue<int>();
            }
            catch
            {
                if (Directory.Exists(child))
                    type = 2;
                else if (File.Exists(child))
                    type = 1;
            }
            entries.Add(new JsonObject { ["name"] = Path.GetFileName(child), ["type"] = type });
        }
        return new() { ["entries"] = entries };
    }

    internal static async Task<byte[]> ReadFileAsync(string path, CancellationToken token)
    {
        var stat = StatFile(path);
        if ((stat["type"]!.GetValue<int>() & 1) == 0)
            throw new CodeServiceException("FileIsADirectory", "Path is not a file.");
        if (stat["size"]!.GetValue<ulong>() > (ulong)MaxFileBytes)
            throw new CodeServiceException("PayloadTooLarge", "File exceeds the Code read limit.");
        using var input = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            65536,
            FileOptions.Asynchronous
        );
        return await ReadBoundedAsync(input, MaxFileBytes, token);
    }

    internal static async Task<byte[]> ReadBoundedAsync(
        Stream input,
        long limit,
        CancellationToken token
    )
    {
        using var output = new MemoryStream();
        var buffer = new byte[65536];
        while (true)
        {
            var read = await input.ReadAsync(buffer, token);
            if (read == 0)
                return output.ToArray();
            if (output.Length + read > limit)
                throw new CodeServiceException(
                    "PayloadTooLarge",
                    "Content exceeds the Code size limit."
                );
            output.Write(buffer, 0, read);
        }
    }

    internal static async Task<JsonObject> WriteFileAsync(
        string path,
        Stream input,
        bool create,
        bool overwrite,
        CancellationToken token
    )
    {
        Parent(path);
        var exists = Exists(path);
        if (!exists && !create)
            throw new CodeServiceException("FileNotFound", "File not found.");
        if (exists)
        {
            if (DirectoryStat(StatFile(path)))
                throw new CodeServiceException("FileIsADirectory", "Path is a directory.");
            if (create && !overwrite)
                throw new CodeServiceException("FileExists", "File already exists.");
        }
        var bytes = await ReadBoundedAsync(input, MaxFileBytes, token);
        using (
            var file = new FileStream(
                path,
                overwrite || exists ? FileMode.Create : FileMode.CreateNew,
                FileAccess.Write,
                FileShare.Read,
                65536,
                FileOptions.Asynchronous
            )
        )
            await file.WriteAsync(bytes, token);
        return new() { ["success"] = true, ["stat"] = StatFile(path) };
    }

    internal static JsonObject CreateDirectory(string path)
    {
        Parent(path);
        if (Exists(path))
            throw new CodeServiceException("FileExists", "Path already exists.");
        Directory.CreateDirectory(path);
        return new() { ["success"] = true, ["stat"] = StatFile(path) };
    }

    internal static JsonObject Delete(string path, bool recursive)
    {
        if (DirectoryStat(StatFile(path)))
            Directory.Delete(path, recursive);
        else
            File.Delete(path);
        return new() { ["success"] = true };
    }

    internal static JsonObject Rename(string oldPath, string newPath, bool overwrite)
    {
        _ = StatFile(oldPath);
        Parent(newPath);
        if (Exists(newPath))
        {
            if (!overwrite)
                throw new CodeServiceException("FileExists", "Destination already exists.");
            Delete(newPath, true);
        }
        if (RenameNative(oldPath, newPath) != 0)
            throw NativeError(oldPath);
        return new() { ["success"] = true };
    }
}
