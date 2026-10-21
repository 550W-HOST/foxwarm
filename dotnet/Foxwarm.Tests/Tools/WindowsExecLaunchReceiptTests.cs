using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class WindowsExecLaunchReceiptTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Missing_or_malformed_helper_receipt_retains_artifacts_and_never_replays_effect(
        bool malformed
    )
    {
        using var temp = new TempDirectory();
        var marker = Path.Combine(temp.Path, "once.txt");
        var log = Path.Combine(temp.Path, "owned.log");
        // Exercise the real BCL receipt stream with a one-shot fixture process.
        // This is a receipt-loss boundary control, not a Windows capture proof.
        var start = OperatingSystem.IsWindows()
            ? new ProcessStartInfo(ExecNative.WindowsPowerShell)
            : new ProcessStartInfo("/bin/sh");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        if (OperatingSystem.IsWindows())
        {
            start.ArgumentList.Add("-NoProfile");
            start.ArgumentList.Add("-NonInteractive");
            start.ArgumentList.Add("-Command");
            start.ArgumentList.Add(
                "Add-Content -LiteralPath '"
                    + marker.Replace("'", "''", StringComparison.Ordinal)
                    + "' -Value once; "
                    + (malformed ? "[Console]::Out.WriteLine('invalid receipt')" : "")
            );
        }
        else
        {
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add(
                "printf 'once\\n' >> \"$1\"; " + (malformed ? "printf 'invalid receipt\\n'" : ":")
            );
            start.ArgumentList.Add("fixture");
            start.ArgumentList.Add(marker);
        }
        var error = Assert.Throws<ExecLaunchUncertainException>(() =>
            WindowsExecProcess.Launch(start, log)
        );
        Assert.Contains(log, error.Message);
        Assert.Contains(log + ".exit.json", error.Message);
        Assert.Contains(log + ".cwd.txt", error.Message);
        Assert.Equal(new[] { "once" }, File.ReadAllLines(marker));
    }

    [Fact]
    public async Task Receipt_deadline_does_not_kill_the_live_effect_or_automatically_repeat_it()
    {
        using var temp = new TempDirectory();
        var pidPath = Path.Combine(temp.Path, "effect.pid");
        var release = Path.Combine(temp.Path, "release");
        var marker = Path.Combine(temp.Path, "once.txt");
        var start = new ProcessStartInfo(
            OperatingSystem.IsWindows() ? ExecNative.WindowsPowerShell : "/bin/sh"
        )
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (OperatingSystem.IsWindows())
        {
            string Quote(string path) =>
                "'" + path.Replace("'", "''", StringComparison.Ordinal) + "'";
            foreach (
                var argument in new[]
                {
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "[IO.File]::WriteAllText("
                        + Quote(pidPath)
                        + ", [string]$PID); "
                        + "while (-not (Test-Path -LiteralPath "
                        + Quote(release)
                        + ")) { Start-Sleep -Milliseconds 25 }; "
                        + "Add-Content -LiteralPath "
                        + Quote(marker)
                        + " -Value once",
                }
            )
                start.ArgumentList.Add(argument);
        }
        else
        {
            foreach (
                var argument in new[]
                {
                    "-c",
                    "printf '%s' \"$$\" > \"$1\"; while [ ! -f \"$2\" ]; do sleep 0.05; done; printf 'once\\n' >> \"$3\"",
                    "fixture",
                    pidPath,
                    release,
                    marker,
                }
            )
                start.ArgumentList.Add(argument);
        }
        try
        {
            Assert.Throws<ExecLaunchUncertainException>(() =>
                WindowsExecProcess.Launch(start, Path.Combine(temp.Path, "owned.log"))
            );
            using var child = Process.GetProcessById(
                int.Parse(
                    await File.ReadAllTextAsync(pidPath),
                    System.Globalization.CultureInfo.InvariantCulture
                )
            );
            Assert.False(child.HasExited);
            await File.WriteAllTextAsync(release, "finish");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            await child.WaitForExitAsync(deadline.Token);
            Assert.Equal(new[] { "once" }, await File.ReadAllLinesAsync(marker));
        }
        finally
        {
            await File.WriteAllTextAsync(release, "finish");
            if (File.Exists(pidPath))
            {
                try
                {
                    using var child = Process.GetProcessById(
                        int.Parse(
                            await File.ReadAllTextAsync(pidPath),
                            System.Globalization.CultureInfo.InvariantCulture
                        )
                    );
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                    await child.WaitForExitAsync(deadline.Token);
                }
                catch (ArgumentException) { }
            }
        }
    }

    [Fact]
    public void Helper_process_creation_failure_is_not_reported_as_an_uncertain_command_effect()
    {
        using var temp = new TempDirectory();
        var start = new ProcessStartInfo(Path.Combine(temp.Path, "missing-helper"))
        {
            UseShellExecute = false,
        };
        Assert.Throws<Win32Exception>(() =>
            WindowsExecProcess.Launch(start, Path.Combine(temp.Path, "owned.log"))
        );
        Assert.Empty(Directory.GetFiles(temp.Path));
    }

    [Fact]
    public void Actual_Windows_helper_rejects_existing_capture_before_executing_the_command()
    {
        if (!OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var script = Path.Combine(temp.Path, "command.ps1");
        var marker = Path.Combine(temp.Path, "should-not-exist");
        File.WriteAllText(
            script,
            "Set-Content -LiteralPath '"
                + marker.Replace("'", "''", StringComparison.Ordinal)
                + "' -Value executed",
            new UTF8Encoding(true)
        );
        var log = Path.Combine(temp.Path, "existing.log");
        File.WriteAllText(log, "preserved");
        var start = ExecNative.Launcher(
            script,
            temp.Path,
            ExecNative.SelfStart(typeof(LocalExecManager).Assembly)
        );
        start.Environment["FOXWARM_EXEC_LOG_PATH"] = log;
        var error = Assert.Throws<Win32Exception>(() => ExecNative.Start(start));
        Assert.Equal(80, error.NativeErrorCode); // CREATE_NEW reports ERROR_FILE_EXISTS.
        Assert.Equal("preserved", File.ReadAllText(log));
        Assert.False(File.Exists(marker));
    }
}
