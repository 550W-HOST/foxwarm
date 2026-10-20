using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Tools;

// Read the opened object, not a path which could already name its replacement.
internal readonly record struct OpenFileMetadata(string Identity, long Size)
{
    internal static OpenFileMetadata Read(SafeFileHandle handle)
    {
        if (OperatingSystem.IsLinux())
        {
            if (Statx(handle.DangerousGetHandle().ToInt32(), "", 0x1000, 0x0fff, out var info) != 0)
                throw new IOException(new Win32Exception(Marshal.GetLastPInvokeError()).Message);
            if ((info.Mode & 0xf000) != 0x8000)
                throw new IOException("The log destination is not a regular file.");
            return new($"{info.DeviceMajor}:{info.DeviceMinor}:{info.Inode}:{info.BirthSeconds}:{info.BirthNanoseconds}", checked((long)info.Size));
        }
        if (OperatingSystem.IsWindows())
        {
            if (!GetFileInformationByHandle(handle, out var info))
                throw new IOException(new Win32Exception(Marshal.GetLastPInvokeError()).Message);
            if ((info.Attributes & 0x50) != 0 || GetFileType(handle) != 1)
                throw new IOException("The log destination is not a regular file.");
            return new($"{info.Volume}:{info.IndexHigh}:{info.IndexLow}:{info.CreationHigh}:{info.CreationLow}", ((long)info.SizeHigh << 32) | info.SizeLow);
        }
        throw new PlatformNotSupportedException("Open-file log identity is supported on Linux and Windows.");
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct LinuxInfo
    {
        [FieldOffset(28)] internal ushort Mode;
        [FieldOffset(32)] internal ulong Inode;
        [FieldOffset(40)] internal ulong Size;
        [FieldOffset(80)] internal long BirthSeconds;
        [FieldOffset(88)] internal uint BirthNanoseconds;
        [FieldOffset(136)] internal uint DeviceMajor;
        [FieldOffset(140)] internal uint DeviceMinor;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowsInfo
    {
        internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
            WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, string path, int flags, uint mask, out LinuxInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out WindowsInfo info);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);
}
