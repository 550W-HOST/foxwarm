using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Foxwarm.Tools;

// Stops a tracked native command on request. POSIX wrappers run as session leaders (setsid), so
// their PID is also the command's process group; Windows ends the wrapper's process tree. The
// recorded start identity guards against signalling a reused PID. Registry and completion
// remain with the caller: a stopped command still finishes through its ordinary status path.
internal static class ExecStop
{
    internal enum Outcome
    {
        // The recorded process was no longer running; nothing was signalled.
        NotRunning,

        // The process group exited after the termination signal.
        Exited,

        // The process group was still running after the grace period and was killed.
        Killed,

        // Windows: the process tree was ended directly.
        TreeEnded,
    }

    internal static readonly TimeSpan Grace = TimeSpan.FromSeconds(5);

    private const int SigTerm = 15;
    private const int SigKill = 9;
    private const int NoSuchProcess = 3;

    internal static bool Running(int pid, string? startTicks)
    {
        var identity = NativeProcessFacts.ReadIdentity(pid);
        return identity.Ticks is not null
            && (startTicks is null || identity.Ticks == startTicks)
            && identity.State != 'Z';
    }

    internal static async Task<Outcome> StopAsync(
        int pid,
        string? startTicks,
        TimeSpan? grace = null,
        CancellationToken token = default
    )
    {
        if (pid <= 0 || !Running(pid, startTicks))
            return Outcome.NotRunning;
        if (OperatingSystem.IsWindows())
            return StopWindowsTree(pid, grace ?? Grace);
        if (Kill(-pid, SigTerm) != 0 && Marshal.GetLastPInvokeError() == NoSuchProcess)
            return Outcome.NotRunning;
        var clock = Stopwatch.StartNew();
        var limit = grace ?? Grace;
        while (clock.Elapsed < limit)
        {
            if (!GroupAlive(pid))
                return Outcome.Exited;
            await Task.Delay(50, token);
        }
        if (!GroupAlive(pid))
            return Outcome.Exited;
        Kill(-pid, SigKill);
        return Outcome.Killed;
    }

    // Any member of the group, including a not yet reaped leader, keeps it alive.
    private static bool GroupAlive(int pgid) =>
        Kill(-pgid, 0) == 0 || Marshal.GetLastPInvokeError() != NoSuchProcess;

    // Detached console-less Windows processes have no dependable soft termination signal, so the
    // tree is ended directly; the wrapper cannot record a status and the exit is reported unknown.
    private static Outcome StopWindowsTree(int pid, TimeSpan grace)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            process.Kill(entireProcessTree: true);
            process.WaitForExit(grace);
            return Outcome.TreeEnded;
        }
        catch (ArgumentException)
        {
            return Outcome.NotRunning;
        }
        catch (InvalidOperationException)
        {
            return Outcome.NotRunning;
        }
    }

    [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
    private static extern int Kill(int pid, int signal);
}
