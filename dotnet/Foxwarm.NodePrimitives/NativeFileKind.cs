using System.ComponentModel;
using System.Runtime.InteropServices;

namespace Foxwarm.Tools;

// FileAttributes does not distinguish Unix special files from regular files.
internal static class NativeFileKind
{
    internal static string Read(string path, bool followLinks = true)
    {
        if (OperatingSystem.IsLinux())
        {
            // Linux statx has a fixed 256-byte ABI; request only the file type.
            if (!TryReadLinux(-100, path, followLinks ? 0 : 0x100, out var kind, out var error))
            {
                throw new IOException(
                    new Win32Exception(error).Message + ": " + path,
                    unchecked((int)0x80070000) | error
                );
            }
            return kind;
        }
        var attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
        {
            if (!followLinks)
                return "symlink";
            if (File.ResolveLinkTarget(path, returnFinalTarget: true) is { } target)
                attributes = target.Attributes;
        }
        return (attributes & FileAttributes.Directory) != 0 ? "directory"
            : (attributes & FileAttributes.Device) != 0 ? "other"
            : "file";
    }

    // Main's policy and opened-handle checks retain their existing flags and errno handling.
    internal static bool TryReadLinux(int directory, string path, int flags, out string kind, out int error)
    {
        if (Statx(directory, path, flags, 1, out var info) != 0)
        {
            error = Marshal.GetLastPInvokeError();
            kind = "other";
            return false;
        }
        error = 0;
        kind = (info.Mode & 0xf000) switch
        {
            0x8000 => "file",
            0x4000 => "directory",
            0xa000 => "symlink",
            _ => "other",
        };
        return true;
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct FileTypeInfo
    {
        [FieldOffset(28)]
        internal ushort Mode;
    }

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(
        int directory,
        string path,
        int flags,
        uint mask,
        out FileTypeInfo info
    );
}