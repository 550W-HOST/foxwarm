using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    [Fact]
    public async Task Actual_system_posix_sh_downloads_the_real_bootstrap_and_checks_dependencies_without_installing()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var fixture = new Fixture();
        await fixture.Start(register: false, bootstrap: true);
        var script = Path.Combine(fixture.Temp.Path, "downloaded-shell.sh");
        using var bootstrap = await fixture.Client.GetAsync("/node/run-shell.sh");
        bootstrap.EnsureSuccessStatusCode();
        await File.WriteAllTextAsync(script, await bootstrap.Content.ReadAsStringAsync());
        var startup = Path.Combine(fixture.Temp.Path, "posix-start");
        var temp = Path.Combine(fixture.Temp.Path, "client-temp");
        Directory.CreateDirectory(startup);
        Directory.CreateDirectory(temp);
        var options = new ProcessStartInfo("/bin/sh")
        {
            WorkingDirectory = startup,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        options.ArgumentList.Add(script);
        options.ArgumentList.Add("--host=" + fixture.Client.BaseAddress!.ToString().TrimEnd('/'));
        options.ArgumentList.Add("--node-id=shell");
        options.Environment["NODE_AUTH_TOKEN"] = fixture.Auth;
        options.Environment["TMPDIR"] = temp;
        using var client = Process.Start(options)!;
        var stdout = client.StandardOutput.ReadToEndAsync();
        var stderr = client.StandardError.ReadToEndAsync();
        try
        {
            using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (!fixture.Manager.Nodes.Online("shell"))
                await Task.Delay(20, budget.Token);
            await fixture.Manager.SelectNodeAsync(fixture.Owner, "shell");
            var result = await fixture
                .Exec(
                    new JsonObject
                    {
                        ["command"] = "printf plain; printf once > plain-effect; exit 7",
                        ["cwd"] = startup,
                    },
                    programmatic: true
                )
                .WaitAsync(budget.Token);
            Assert.Equal("plain", result!["content"]!.GetValue<string>());
            Assert.Equal(7, result["exitCode"]!.GetValue<int>());
            Assert.Equal(
                "once",
                await File.ReadAllTextAsync(Path.Combine(startup, "plain-effect"))
            );
            fixture.Manager.Nodes.Remove("shell");
            await client.WaitForExitAsync(budget.Token);
            Assert.Equal(0, client.ExitCode);
            Assert.DoesNotContain(fixture.Auth, await stdout);
            Assert.DoesNotContain(fixture.Auth, await stderr);
        }
        finally
        {
            if (!client.HasExited)
            {
                client.Kill(entireProcessTree: true);
                await client.WaitForExitAsync();
            }
        }
        // A missing utility is a startup failure, not a package installation or registration.
        var missing = Path.Combine(fixture.Temp.Path, "empty-path");
        Directory.CreateDirectory(missing);
        options.Environment["PATH"] = missing;
        using var denied = Process.Start(options)!;
        var deniedOutput = denied.StandardOutput.ReadToEndAsync();
        var deniedError = denied.StandardError.ReadToEndAsync();
        await denied.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.NotEqual(0, denied.ExitCode);
        Assert.False(fixture.Manager.Nodes.Connected("shell"));
        Assert.DoesNotContain(fixture.Auth, await deniedOutput);
        Assert.DoesNotContain(fixture.Auth, await deniedError);
    }
}
