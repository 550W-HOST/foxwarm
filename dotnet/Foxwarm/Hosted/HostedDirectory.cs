using System.Runtime.InteropServices;

namespace Foxwarm.Hosted;

/// <summary>Resolves a mounted directory in filesystem order for hosted startup and offline import.</summary>
internal static class HostedDirectory
{
    [DllImport("libc", EntryPoint = "realpath", SetLastError = true)]
    private static extern IntPtr RealPath(string path, IntPtr buffer);

    [DllImport("libc", EntryPoint = "free")]
    private static extern void Free(IntPtr buffer);

    internal static string ExistingDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            if (path.Replace('/', '\\').Split('\\').Contains("..")) throw Unresolved(path);
            for (var dir = new DirectoryInfo(path); dir is not null; dir = dir.Parent)
                if (!dir.Exists || (dir.Attributes & FileAttributes.ReparsePoint) != 0) throw Unresolved(path);
            return Path.GetFullPath(path);
        }
        var resolved = ExistingPath(path);
        return Directory.Exists(resolved) ? resolved : throw Unresolved(path);
    }

    internal static string ExistingPath(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            // Open the resolved object (backup semantics also opens directories). A junction
            // or relative link is interpreted by the filesystem, including all ancestors.
            using var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
            if (handle.IsInvalid) throw Unresolved(path);
            var buffer = new System.Text.StringBuilder(32768);
            var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) throw Unresolved(path);
            var final = buffer.ToString();
            return final.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) ? @"\\" + final[8..]
                : final.StartsWith(@"\\?\", StringComparison.Ordinal) ? final[4..] : final;
        }
        var address = RealPath(path, IntPtr.Zero);
        if (address == IntPtr.Zero) throw Unresolved(path);
        try { return Marshal.PtrToStringUTF8(address) ?? throw Unresolved(path); }
        finally { Free(address); }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateFileW", ExactSpelling = true)]
    private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFile(string path, uint access, uint share,
        IntPtr securityAttributes, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetFinalPathNameByHandleW", ExactSpelling = true)]
    private static extern uint GetFinalPathNameByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle file,
        System.Text.StringBuilder path, uint capacity, uint flags);

    private static IOException Unresolved(string path) => new($"Cannot resolve an existing directory on the filesystem: {path}.");
}
