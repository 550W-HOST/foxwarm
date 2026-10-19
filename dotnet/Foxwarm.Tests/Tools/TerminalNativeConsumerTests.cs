using System.Diagnostics;
using Foxwarm.Terminal;

namespace Foxwarm.Tests;

public sealed class TerminalNativeConsumerTests
{
    [Fact]
    public async Task Main_registry_keeps_real_shell_cwd_dimensions_and_process_cleanup_after_extraction()
    {
        if (!OperatingSystem.IsLinux() || !TerminalRegistry.IsSupported)
            return;
        using var temp = new TempDirectory();
        var child = Path.Combine(temp.Path, "directory space 雪");
        Directory.CreateDirectory(child);
        var dimensions = Path.Combine(temp.Path, "dimensions");
        var marker = Path.Combine(temp.Path, "marker");
        var descriptors = TerminalNative.Handle.OwnedFdCount;
        await using var registry = new TerminalRegistry(temp.Path, CancellationToken.None);
        var terminal = await registry.CreateAsync(temp.Path, 88, 27, CancellationToken.None);
        var pid = terminal.Describe()["pid"]!.GetValue<int>();
        try
        {
            terminal.Resize(91, 37);
            await terminal.InputAsync(
                $"stty size > '{dimensions}'; cd '{child}'; printf '%s' \"$$\" > '{marker}'\n"
            );
            await Eventually(() =>
                File.Exists(marker) && File.ReadAllText(marker) == pid.ToString()
            );
            Assert.Equal("37 91", (await File.ReadAllTextAsync(dimensions)).Trim());
            await Eventually(() => terminal.Describe()["cwd"]!.ToString() == child);
            Assert.Equal(91, terminal.Describe()["cols"]!.GetValue<int>());
            Assert.Single(registry.List());
        }
        finally
        {
            await registry.CloseAsync(terminal.Id, "fixture-complete");
        }
        Assert.Empty(registry.List());
        Assert.Equal(descriptors, TerminalNative.Handle.OwnedFdCount);
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }

    [Fact]
    public async Task Main_same_executable_helper_enters_local_capability_ipc_before_host_startup()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var file = Path.Combine(temp.Path, "literal space 雪.txt");
        await File.WriteAllTextAsync(file, "first\nsecond\nthird\n");
        CodeHelperServer.CodeHelperRequest? observed = null;
        string? terminalId = null;
        await using var helper = new CodeHelperServer(
            temp.Path,
            (terminal, requestId, request) =>
            {
                terminalId = terminal;
                observed = request;
                return Task.FromResult(
                    new CodeHelperServer.CodeHelperResult(
                        true,
                        "Main IPC acknowledged",
                        null,
                        requestId
                    )
                );
            }
        );
        var registration = await helper.RegisterAsync("owned-main-terminal");
        async Task<(int Code, string Output, string Error)> Invoke()
        {
            var executable = Environment.GetEnvironmentVariable("DOTNET_ROOT") is { } root
                ? Path.Combine(root, "dotnet")
                : "dotnet";
            var start = new ProcessStartInfo(executable)
            {
                WorkingDirectory = temp.Path,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            start.ArgumentList.Add(typeof(HttpServer).Assembly.Location);
            start.ArgumentList.Add("--code-helper");
            start.ArgumentList.Add("--goto");
            start.ArgumentList.Add("literal space 雪.txt:3:2");
            foreach (var pair in registration.Environment)
                start.Environment[pair.Key] = pair.Value;
            using var process = Process.Start(start)!;
            var output = process.StandardOutput.ReadToEndAsync();
            var error = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            return (process.ExitCode, await output, await error);
        }
        var accepted = await Invoke();
        Assert.Equal(0, accepted.Code);
        Assert.Contains("Main IPC acknowledged", accepted.Output);
        Assert.Equal("owned-main-terminal", terminalId);
        Assert.Equal(new CodeHelperServer.CodeHelperRequest("openFile", file, 3, 2), observed);
        helper.Unregister(registration.Capability);
        observed = null;
        var expired = await Invoke();
        Assert.Equal(1, expired.Code);
        Assert.Contains("invalid or expired", expired.Error);
        Assert.Null(observed);
        var socket = registration.Environment["FOXWARM_CODE_IPC"];
        await helper.DisposeAsync();
        Assert.False(File.Exists(socket));
        Assert.False(
            Directory.Exists(
                Path.GetDirectoryName(registration.Environment["PATH"].Split(Path.PathSeparator)[0])
            )
        );
    }

    private static async Task Eventually(Func<bool> check)
    {
        var timeout = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < timeout)
        {
            if (check())
                return;
            await Task.Delay(20);
        }
        Assert.True(check());
    }
}
