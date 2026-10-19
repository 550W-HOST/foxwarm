using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace Foxwarm.Code;

internal static class CodeFileOperations
{
    internal const long MaxFileBytes = 50L * 1024 * 1024;

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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string oldPath, string newPath, uint flags);

    private static CodeServiceException NativeError(string path)
    {
        var errno = Marshal.GetLastPInvokeError();
        var code = OperatingSystem.IsWindows()
            ? errno switch
            {
                2 or 3 => "FileNotFound",
                5 => "NoPermissions",
                80 or 183 => "FileExists",
                145 => "DirectoryNotEmpty",
                267 => "FileNotADirectory",
                _ => "Unknown",
            }
            : errno switch
            {
                2 => "FileNotFound",
                20 => "FileNotADirectory",
                21 => "FileIsADirectory",
                13 or 1 => "NoPermissions",
                17 => "FileExists",
                39 => "DirectoryNotEmpty",
                _ => "Unknown",
            };
        return FileError(code, path, new System.ComponentModel.Win32Exception(errno).Message);
    }

    internal static Exception FileError(Exception error, string path)
    {
        if (error is CodeServiceException)
            return error;
        var code = error switch
        {
            UnauthorizedAccessException => "NoPermissions",
            FileNotFoundException => "FileNotFound",
            IOException => (error.HResult & 0xffff) switch
            {
                2 or 3 => "FileNotFound",
                20 or 267 => "FileNotADirectory",
                21 => "FileIsADirectory",
                5 or 13 => "NoPermissions",
                17 or 80 or 183 => "FileExists",
                39 or 145 => "DirectoryNotEmpty",
                _ => "Unknown",
            },
            _ => "Unknown",
        };
        return FileError(code, path, error.Message);
    }

    private static CodeServiceException FileError(string code, string path, string fallback) =>
        new(
            code,
            code switch
            {
                "FileNotFound" => "File not found: " + path,
                "FileExists" => "Path already exists: " + path,
                "FileNotADirectory" => "Path is not a directory: " + path,
                "FileIsADirectory" => "Path is a directory: " + path,
                "NoPermissions" => "Permission denied: " + path,
                "DirectoryNotEmpty" => "Directory is not empty: " + path,
                _ => fallback,
            }
        );

    [DllImport("libc", EntryPoint = "mkdir", SetLastError = true)]
    private static extern int MakeDirectory(string path, uint mode);

    [DllImport(
        "kernel32.dll",
        EntryPoint = "CreateDirectoryW",
        CharSet = CharSet.Unicode,
        SetLastError = true
    )]
    private static extern bool MakeDirectoryWindows(string path, IntPtr securityAttributes);

    private static LinuxStat Stat(string path, bool link)
    {
        if (!OperatingSystem.IsLinux())
            throw new CodeServiceException(
                "Unavailable",
                "Code filesystem services require a supported native host."
            );
        if (Statx(-100, path, link ? 0x100 : 0, 0x7ff, out var info) != 0)
            throw NativeError(path);
        return info;
    }

    internal static JsonObject StatFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                var attributes = File.GetAttributes(path);
                var directory = (attributes & FileAttributes.Directory) != 0;
                FileSystemInfo info = directory ? new DirectoryInfo(path) : new FileInfo(path);
                var isLink = (attributes & FileAttributes.ReparsePoint) != 0;
                if (isLink && info.ResolveLinkTarget(true) is { } target)
                    info = target;
                directory = (info.Attributes & FileAttributes.Directory) != 0;
                return new()
                {
                    ["type"] = (directory ? 2 : 1) | (isLink ? 64 : 0),
                    ["ctime"] = new DateTimeOffset(info.CreationTimeUtc).ToUnixTimeMilliseconds(),
                    ["mtime"] = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                    ["size"] = directory ? 0UL : checked((ulong)((FileInfo)info).Length),
                };
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                throw FileError(error, path);
            }
        }
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
        var result = new JsonObject
        {
            ["type"] = type,
            ["ctime"] = actual.ChangeSeconds * 1000d + actual.ChangeNanoseconds / 1_000_000d,
            ["mtime"] = actual.ModifiedSeconds * 1000d + actual.ModifiedNanoseconds / 1_000_000d,
            ["size"] = actual.Size,
        };
        if ((actual.Mode & 0x80) == 0)
            result["permissions"] = 1;
        return result;
    }

    private static bool DirectoryStat(JsonObject stat) => (stat["type"]!.GetValue<int>() & 2) != 0;

    private static bool Exists(string path)
    {
        try
        {
            _ = StatFile(path);
            return true;
        }
        catch (CodeServiceException)
        {
            return false;
        }
    }

    private static void Parent(string path)
    {
        if (!DirectoryStat(StatFile(Path.GetDirectoryName(path) ?? Path.GetPathRoot(path)!)))
            throw new CodeServiceException(
                "FileNotADirectory",
                "Parent is not a directory: " + Path.GetDirectoryName(path)
            );
    }

    internal static JsonObject ReadDirectory(string path)
    {
        if (!DirectoryStat(StatFile(path)))
            throw new CodeServiceException("FileNotADirectory", "Path is not a directory: " + path);
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
                // Source falls back to the directory entry itself, never follows a broken link.
                try
                {
                    if (OperatingSystem.IsLinux())
                        type = (Stat(child, true).Mode & 0xf000) switch
                        {
                            0x8000 => 1,
                            0x4000 => 2,
                            _ => 0,
                        };
                    else
                    {
                        var attributes = File.GetAttributes(child);
                        type =
                            (attributes & FileAttributes.ReparsePoint) != 0 ? 0
                            : (attributes & FileAttributes.Directory) != 0 ? 2
                            : 1;
                    }
                }
                catch (Exception error)
                    when (error
                            is CodeServiceException
                                or IOException
                                or UnauthorizedAccessException
                    ) { }
            }
            entries.Add(
                (JsonNode)new JsonObject { ["name"] = Path.GetFileName(child), ["type"] = type }
            );
        }
        return new() { ["entries"] = entries };
    }

    internal static async Task<byte[]> ReadFileAsync(string path, CancellationToken token)
    {
        var stat = StatFile(path);
        if ((stat["type"]!.GetValue<int>() & 1) == 0)
            throw new CodeServiceException("FileIsADirectory", "Path is not a file: " + path);
        if (stat["size"]!.GetValue<ulong>() > (ulong)MaxFileBytes)
            throw new CodeServiceException(
                "PayloadTooLarge",
                "File exceeds " + MaxFileBytes + " bytes: " + path
            );
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
            throw new CodeServiceException("FileNotFound", "File not found: " + path);
        if (exists)
        {
            if (DirectoryStat(StatFile(path)))
                throw new CodeServiceException("FileIsADirectory", "Path is a directory: " + path);
            if (create && !overwrite)
                throw new CodeServiceException("FileExists", "File already exists: " + path);
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
            throw new CodeServiceException("FileExists", "Path already exists: " + path);
        if (
            OperatingSystem.IsWindows()
                ? !MakeDirectoryWindows(path, IntPtr.Zero)
                : MakeDirectory(path, 0x1ff) != 0
        )
            throw NativeError(path);
        return new() { ["success"] = true, ["stat"] = StatFile(path) };
    }

    internal static JsonObject Delete(string path, bool recursive)
    {
        var stat = StatFile(path);
        if (DirectoryStat(stat))
        {
            if (!recursive && (stat["type"]!.GetValue<int>() & 64) == 0)
                throw new CodeServiceException(
                    "Unknown",
                    "Path is a directory: rm returned EISDIR (is a directory) " + path
                );
            Directory.Delete(path, recursive);
        }
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
                throw new CodeServiceException("FileExists", "Destination exists: " + newPath);
            Delete(newPath, true);
        }
        if (
            OperatingSystem.IsWindows()
                ? !MoveFileExW(oldPath, newPath, 0)
                : RenameNative(oldPath, newPath) != 0
        )
            throw NativeError(oldPath);
        return new() { ["success"] = true };
    }
}
