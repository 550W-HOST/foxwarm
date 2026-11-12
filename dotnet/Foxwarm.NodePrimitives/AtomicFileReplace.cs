using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Tools;

/// <summary>
/// Publishes a fully written temporary file over its destination in one rename.
/// </summary>
/// <remarks>
/// On Windows, <see cref="File.Move(string, string, bool)"/> cannot replace a destination that
/// another process has open, even when that reader allows deletion (Node's fs.readFile and most
/// scanners do). A POSIX-semantics rename replaces it while such a reader keeps its handle to the
/// old contents. A reader that does not allow deletion still blocks the replacement; callers keep
/// their own handling for that failure. Volumes without POSIX rename use File.Move.
/// </remarks>
internal static class AtomicFileReplace
{
    private const uint Delete = 0x00010000;
    private const uint Synchronize = 0x00100000;
    private const uint ShareAll = 0x7;
    private const uint OpenExisting = 3;
    private const int FileRenameInfoEx = 22;
    private const uint ReplaceIfExists = 0x1;
    private const uint PosixSemantics = 0x2;

    internal static void Replace(string temporary, string destination)
    {
        if (
            !OperatingSystem.IsWindows()
            || IntPtr.Size != 8
            || !TryPosixRename(temporary, destination)
        )
            File.Move(temporary, destination, true);
    }

    // False when the volume or Windows version does not support this rename.
    private static bool TryPosixRename(string temporary, string destination)
    {
        using var handle = CreateFileW(
            Extended(temporary),
            Delete | Synchronize,
            ShareAll,
            IntPtr.Zero,
            OpenExisting,
            0,
            IntPtr.Zero
        );
        if (handle.IsInvalid)
            throw Failure(Marshal.GetLastPInvokeError(), temporary);
        // FILE_RENAME_INFO on 64-bit Windows: Flags (4 bytes, padded to 8), RootDirectory
        // (8 bytes), FileNameLength (4 bytes), then the UTF-16 name without a terminator.
        var name = Encoding.Unicode.GetBytes(Extended(destination));
        var info = new byte[20 + name.Length + 2];
        BitConverter.TryWriteBytes(info.AsSpan(0, 4), ReplaceIfExists | PosixSemantics);
        BitConverter.TryWriteBytes(info.AsSpan(16, 4), (uint)name.Length);
        name.CopyTo(info, 20);
        if (SetFileInformationByHandle(handle, FileRenameInfoEx, info, (uint)info.Length))
            return true;
        var error = Marshal.GetLastPInvokeError();
        // ERROR_INVALID_FUNCTION, ERROR_NOT_SUPPORTED, ERROR_INVALID_PARAMETER: no POSIX rename here.
        if (error is 1 or 50 or 87)
            return false;
        throw Failure(error, destination);
    }

    private static string Extended(string path)
    {
        var full = Path.GetFullPath(path);
        if (full.StartsWith(@"\\?\", StringComparison.Ordinal))
            return full;
        return full.StartsWith(@"\\", StringComparison.Ordinal)
            ? @"\\?\UNC\" + full[2..]
            : @"\\?\" + full;
    }

    // The exception types File.Move reports for the same conditions.
    private static Exception Failure(int error, string path) =>
        error switch
        {
            2 => new FileNotFoundException(new Win32Exception(error).Message, path),
            3 => new DirectoryNotFoundException(new Win32Exception(error).Message),
            5 => new UnauthorizedAccessException(
                $"Access to the path '{path}' is denied.",
                new Win32Exception(error)
            ),
            _ => new IOException(new Win32Exception(error).Message, new Win32Exception(error)),
        };

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string name,
        uint access,
        uint share,
        IntPtr security,
        uint disposition,
        uint flags,
        IntPtr template
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle handle,
        int infoClass,
        byte[] info,
        uint size
    );
}
