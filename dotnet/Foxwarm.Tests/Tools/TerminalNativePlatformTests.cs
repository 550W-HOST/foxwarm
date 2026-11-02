using System.Text;
using Foxwarm.Terminal;

namespace Foxwarm.Tests;

public sealed class TerminalNativePlatformTests
{
    private static Dictionary<string, string> EnvironmentFor(string home) => new()
    {
        ["HOME"] = home,
        ["TERM"] = "xterm-256color",
        ["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin",
    };

    [Fact]
    public async Task Posix_pty_transports_input_output_and_resize_then_releases_owned_descriptors()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        Assert.True(TerminalNative.IsSupported);
        using var temp = new TempDirectory();
        var baseline = TerminalNative.Handle.OwnedFdCount;
        var handle = TerminalNative.Handle.Spawn("/bin/bash", ["--noprofile", "--norc", "-i"],
            temp.Path, EnvironmentFor(temp.Path), 80, 24);
        Task<string>? read = null;
        var wait = Task.Run(handle.Wait);
        try
        {
            Assert.Equal(handle.Pid, handle.Session);
            handle.Resize(95, 39);
            read = Task.Run(() =>
            {
                var buffer = new byte[4096];
                var text = new StringBuilder();
                while (text.Length < 65536)
                {
                    var count = handle.Read(buffer);
                    if (count <= 0) break;
                    text.Append(Encoding.UTF8.GetString(buffer, 0, (int)count));
                    if (text.ToString().Contains("PTY_input_OK") && text.ToString().Contains("39 95"))
                        return text.ToString();
                }
                throw new IOException("PTY did not produce the requested output.");
            });
            handle.Write(Encoding.UTF8.GetBytes("stty -echo; printf 'PTY_%s_OK\\n' input; stty size\n"));
            var output = await read.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Contains("PTY_input_OK", output);
            Assert.Contains("39 95", output);
        }
        finally
        {
            handle.CancelRead();
            handle.SignalShell(9);
            Assert.Equal(0, (await wait.WaitAsync(TimeSpan.FromSeconds(10))).Error);
            if (read is not null) { try { await read; } catch (IOException) { } }
            handle.Dispose();
        }
        Assert.Equal(baseline, TerminalNative.Handle.OwnedFdCount);
    }

    [Fact]
    public async Task Cancellation_wakes_blocked_read_and_failed_spawn_does_not_leak_descriptors()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        Assert.True(TerminalNative.IsSupported);
        using var temp = new TempDirectory();
        var baseline = TerminalNative.Handle.OwnedFdCount;
        Assert.Throws<IOException>(() => TerminalNative.Handle.Spawn("/foxwarm-missing-shell", [],
            temp.Path, EnvironmentFor(temp.Path), 80, 24));
        Assert.Equal(baseline, TerminalNative.Handle.OwnedFdCount);
        var handle = TerminalNative.Handle.Spawn("/bin/bash", ["-c", "read -r line"],
            temp.Path, EnvironmentFor(temp.Path), 80, 24);
        var read = Task.Run(() => handle.Read(new byte[16]));
        var wait = Task.Run(handle.Wait);
        try
        {
            handle.CancelRead();
            Assert.Equal(OperatingSystem.IsMacOS() ? -89L : -125L,
                await read.WaitAsync(TimeSpan.FromSeconds(5)));
        }
        finally
        {
            handle.CancelRead();
            handle.SignalShell(9);
            Assert.Equal(0, (await wait.WaitAsync(TimeSpan.FromSeconds(10))).Error);
            await read;
            handle.Dispose();
        }
        Assert.Equal(baseline, TerminalNative.Handle.OwnedFdCount);
    }
}
