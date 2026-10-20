using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Tools;

internal static class AppendLogFile
{
    // FileMode.Append retains a managed position; another process can append
    // beyond it. Native append rights keep every actual write at the current EOF.
    internal static FileStream Open(string path)
    {
        SafeFileHandle handle;
        if (OperatingSystem.IsLinux())
            handle = new SafeFileHandle((IntPtr)OpenLinux(path, 0x80441, 0x1b6), ownsHandle: true);
        else if (OperatingSystem.IsWindows())
            handle = CreateFile(path, 4, 7, IntPtr.Zero, 4, 0x80, IntPtr.Zero);
        else
            throw new PlatformNotSupportedException("Main file logging is supported on Linux and Windows.");
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new IOException(new Win32Exception(error).Message);
        }
        try { return new FileStream(handle, FileAccess.Write, 1, isAsync: false); }
        catch { handle.Dispose(); throw; }
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int OpenLinux(string path, int flags, uint mode);
    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint attributes, IntPtr template);
}
