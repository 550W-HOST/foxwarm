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
        string resolved;
        if (OperatingSystem.IsWindows())
        {
            // A lexical Windows path is sufficient only without parent traversal or reparse points.
            if (path.Replace('/', '\\').Split('\\').Contains("..")) throw Unresolved(path);
            resolved = Path.GetFullPath(path);
            for (var dir = new DirectoryInfo(resolved); dir is not null; dir = dir.Parent)
                if (!dir.Exists || (dir.Attributes & FileAttributes.ReparsePoint) != 0) throw Unresolved(path);
        }
        else
        {
            // realpath walks links and parent components in filesystem order. Path.GetFullPath
            // first would change e.g. a symlink target `another-link/../volume`.
            var buffer = RealPath(path, IntPtr.Zero);
            if (buffer == IntPtr.Zero) throw Unresolved(path);
            try { resolved = Marshal.PtrToStringUTF8(buffer) ?? throw Unresolved(path); }
            finally { Free(buffer); }
        }
        return Directory.Exists(resolved) ? resolved : throw Unresolved(path);
    }

    private static IOException Unresolved(string path) => new($"Cannot resolve an existing directory on the filesystem: {path}.");
}
