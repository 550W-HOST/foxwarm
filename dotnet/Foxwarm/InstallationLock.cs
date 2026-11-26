using System.Text;

namespace Foxwarm;

/// <summary>
/// Holds the data directory for one Main process. The lock is an exclusive open of
/// <c>state/main.lock</c>: .NET implements <see cref="FileShare.None"/> as <c>flock(LOCK_EX)</c>
/// on Unix and as an exclusive share mode on Windows. The operating system releases it when the
/// process exits in any way, so there is no stale-lock state to recover, and the file is never
/// deleted. Child processes don't inherit it because .NET opens files close-on-exec.
/// Setting <c>DOTNET_SYSTEM_IO_DISABLEFILELOCKING</c> turns the Unix lock off for the process.
/// </summary>
internal sealed class InstallationLock : IDisposable
{
    internal const string FileName = "main.lock";
    private readonly FileStream file;

    internal string DataRoot { get; }

    private InstallationLock(string dataRoot, FileStream file)
    {
        DataRoot = dataRoot;
        this.file = file;
    }

    internal static string PathFor(string dataRoot) =>
        Path.Combine(Path.GetFullPath(dataRoot), "state", FileName);

    /// <summary>Acquires the lock without waiting.</summary>
    /// <exception cref="InstallationLockedException">Another process holds it.</exception>
    internal static InstallationLock Acquire(string dataRoot)
    {
        var root = Path.GetFullPath(dataRoot);
        var path = PathFor(root);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        FileStream file;
        try
        {
            file = new FileStream(
                path,
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            );
        }
        catch (IOException error) when (IsHeldElsewhere(error))
        {
            throw new InstallationLockedException(root, error);
        }
        try
        {
            // Diagnostics only: the operating-system lock, not this text, is the guard.
            file.SetLength(0);
            var pid = Encoding.ASCII.GetBytes(Environment.ProcessId + "\n");
            file.Write(pid);
            file.Flush();
        }
        catch
        {
            file.Dispose();
            throw;
        }
        return new InstallationLock(root, file);
    }

    /// <summary>
    /// Holds the lock of a data directory without changing it, for tools that read an
    /// installation while Main must be stopped. Only an existing lock file is opened, read-only,
    /// so nothing is created or written; null when the file doesn't exist.
    /// </summary>
    /// <exception cref="InstallationLockedException">Another process holds it.</exception>
    internal static InstallationLock? HoldExisting(string dataRoot)
    {
        var root = Path.GetFullPath(dataRoot);
        try
        {
            return new InstallationLock(
                root,
                new FileStream(PathFor(root), FileMode.Open, FileAccess.Read, FileShare.None)
            );
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
        catch (IOException error) when (IsHeldElsewhere(error))
        {
            throw new InstallationLockedException(root, error);
        }
    }

    private static bool IsHeldElsewhere(IOException error)
    {
        if (error.GetType() != typeof(IOException))
            return false;
        if (OperatingSystem.IsWindows())
            // ERROR_SHARING_VIOLATION or ERROR_LOCK_VIOLATION.
            return (error.HResult & 0xFFFF) is 32 or 33;
        // The flock errno: EWOULDBLOCK is 11 on Linux and 35 on macOS.
        return error.HResult == (OperatingSystem.IsLinux() ? 11 : 35);
    }

    public void Dispose() => file.Dispose();
}

internal sealed class InstallationLockedException(string dataRoot, Exception inner)
    : IOException(Describe(dataRoot), inner)
{
    internal string DataRoot { get; } = dataRoot;

    // Windows denies reading the file while it is held; on Unix it can be read with ordinary tools.
    private static string Describe(string dataRoot) =>
        $"Another Foxwarm Main is already running with data directory {dataRoot}."
        + (
            OperatingSystem.IsWindows()
                ? ""
                : $" Its process ID is in state/{InstallationLock.FileName}."
        );
}
