using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Foxwarm.Desktop;

// The per-user single-instance lock, and the exit request through which the installer stops a
// running copy before it replaces or removes the program files.
internal static class DesktopInstance
{
    private const int ExitTimeoutMilliseconds = 60_000;
    private static readonly NamedWaitHandleOptions Options = new()
    {
        CurrentUserOnly = true,
        CurrentSessionOnly = false,
    };
    private static readonly string User = WindowsIdentity.GetCurrent().User!.Value;

    internal static Mutex Lock() => new(false, "Foxwarm.Desktop." + User, Options);

    // Created by the copy that holds the lock; a signal makes it exit as its Exit menu item does.
    internal static EventWaitHandle ExitRequests() =>
        new(false, EventResetMode.AutoReset, "Foxwarm.Desktop.Exit." + User, Options, out _);

    // `Foxwarm.Desktop.exe --exit`: stops the Foxwarm started from this executable, if any, and
    // waits until no process runs this executable. A copy elsewhere, such as an extracted ZIP, is
    // left alone. Returns 0 once none remains, 1 if one still does after the wait.
    internal static int RequestExit()
    {
        var executable = Path.GetFullPath(
            Environment.ProcessPath ?? throw new IOException("Cannot locate the executable.")
        );
        var processes = Running(executable);
        if (processes.Count == 0)
            return 0;
        var signaled = false;
        var clock = Stopwatch.StartNew();
        try
        {
            while (true)
            {
                // The copy creates its request event just after taking the lock.
                if (!signaled && EventWaitHandle.TryOpenExisting("Foxwarm.Desktop.Exit." + User, Options, out var request))
                {
                    using (request)
                        request.Set();
                    signaled = true;
                }
                processes.RemoveAll(process =>
                {
                    if (WaitForSingleObject(process, 0) != 0)
                        return false;
                    process.Dispose();
                    return true;
                });
                if (processes.Count == 0)
                    return 0;
                if (clock.ElapsedMilliseconds >= ExitTimeoutMilliseconds)
                    return 1;
                Thread.Sleep(250);
            }
        }
        finally
        {
            foreach (var process in processes)
                process.Dispose();
        }
    }

    // Other processes of this executable: the Desktop itself and its helper children.
    private static List<SafeProcessHandle> Running(string executable)
    {
        var found = new List<SafeProcessHandle>();
        foreach (var process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable)))
        {
            using (process)
            {
                if (process.Id == Environment.ProcessId)
                    continue;
                // PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE; other users' processes are not opened.
                var handle = OpenProcess(0x1000 | 0x100000, false, process.Id);
                if (!handle.IsInvalid && string.Equals(ImagePath(handle), executable, StringComparison.OrdinalIgnoreCase))
                    found.Add(handle);
                else
                    handle.Dispose();
            }
        }
        return found;
    }

    private static string? ImagePath(SafeProcessHandle process)
    {
        var buffer = new char[32768];
        var length = buffer.Length;
        return QueryFullProcessImageName(process, 0, buffer, ref length) ? new string(buffer, 0, length) : null;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int processId);

    [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageName(SafeProcessHandle process, uint flags, char[] name, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeProcessHandle handle, uint milliseconds);
}
