using System.Diagnostics;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class NativeProcessFactsTests
{
    [Fact]
    public void Current_process_has_stable_identity_and_missing_pid_has_none()
    {
        var first = NativeProcessFacts.ReadIdentity(Environment.ProcessId);
        Assert.NotNull(first.Ticks);
        Assert.NotEqual('Z', first.State);
        Assert.Equal(first.Ticks, NativeProcessFacts.ReadIdentity(Environment.ProcessId).Ticks);
        Assert.Null(NativeProcessFacts.ReadIdentity(int.MaxValue).Ticks);
    }

    [Fact]
    public async Task Darwin_live_directory_tracks_the_actual_process_and_finished_identity_disappears()
    {
        if (!OperatingSystem.IsMacOS()) return;
        using var temp = new TempDirectory();
        var start = new ProcessStartInfo("/bin/bash")
        {
            WorkingDirectory = temp.Path,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            ArgumentList = { "-c", "cd /; printf 'ready\\n'; exec sleep 30" },
        };
        using var child = Process.Start(start)!;
        try
        {
            Assert.Equal("ready", await child.StandardOutput.ReadLineAsync());
            var identity = NativeProcessFacts.ReadIdentity(child.Id);
            Assert.NotNull(identity.Ticks);
            Assert.Equal("/", NativeProcessFacts.ReadDarwinWorkingDirectory(child.Id));
            Assert.Equal(identity.Ticks, NativeProcessFacts.ReadIdentity(child.Id).Ticks);
        }
        finally
        {
            if (!child.HasExited) child.Kill();
            await child.WaitForExitAsync();
        }
        Assert.Null(NativeProcessFacts.ReadIdentity(child.Id).Ticks);
        Assert.Null(NativeProcessFacts.ReadDarwinWorkingDirectory(child.Id));
    }
}
