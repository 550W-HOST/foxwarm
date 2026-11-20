using System.Text.Json.Nodes;
using Foxwarm.CliNode;
using Foxwarm.Terminal;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class IndependentProcessEnvironmentTests
{
    private sealed class HostEnvironment : IDisposable
    {
        private readonly Dictionary<string, string?> previous = new();

        internal HostEnvironment(string root)
        {
            foreach (var (key, value) in new Dictionary<string, string>
            {
                ["TMUX"] = Path.Combine(root, "host.sock") + ",123,0",
                ["TMUX_PANE"] = "%7",
                ["TMUX_TMPDIR"] = root,
                ["FOXWARM_ENV_PROBE"] = "ordinary value",
                ["FOXWARM_AGENT_DIR"] = root,
                ["SHELL"] = "/bin/bash",
            })
            {
                previous[key] = Environment.GetEnvironmentVariable(key);
                Environment.SetEnvironmentVariable(key, value);
            }
        }

        internal void AssertUnchanged(string root)
        {
            Assert.Equal(Path.Combine(root, "host.sock") + ",123,0", Environment.GetEnvironmentVariable("TMUX"));
            Assert.Equal("%7", Environment.GetEnvironmentVariable("TMUX_PANE"));
        }

        public void Dispose()
        {
            foreach (var (key, value) in previous)
                Environment.SetEnvironmentVariable(key, value);
        }
    }

    private const string Probe = "printf '%s\\n' \"${TMUX-unset}\" \"${TMUX_PANE-unset}\" \"$FOXWARM_ENV_PROBE\" \"$TMUX_TMPDIR\"";

    [Fact]
    public async Task Main_exec_removes_host_tmux_context_but_preserves_other_environment_and_command_assignments()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
            return;
        using var temp = new TempDirectory();
        using var environment = new HostEnvironment(temp.Path);
        await using var manager = new LocalExecManager(temp.Path, _ => temp.Path, (_, _, _) => Task.CompletedTask);
        var result = await manager.ExecuteAsync("main/owned", new JsonObject
        {
            ["command"] = Probe + "; TMUX=explicit TMUX_PANE=chosen /bin/bash -c 'printf \"%s %s\\n\" \"$TMUX\" \"$TMUX_PANE\"'",
            ["timeout"] = 10,
        }, default);
        Assert.Null(result["error"]);
        Assert.Contains("unset\nunset\nordinary value\n" + temp.Path + "\nexplicit chosen\n", result["output"]!.ToString());
        environment.AssertUnchanged(temp.Path);
    }

    [Fact]
    public async Task Main_exec_drops_inherited_variables_whose_value_is_a_known_secret()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
            return;
        using var temp = new TempDirectory();
        using var environment = new HostEnvironment(temp.Path);
        var previous = Environment.GetEnvironmentVariable("FOXWARM_SECRET_PROBE");
        Environment.SetEnvironmentVariable("FOXWARM_SECRET_PROBE", "synthetic-known-secret-value");
        try
        {
            await using var manager = new LocalExecManager(temp.Path, _ => temp.Path, (_, _, _) => Task.CompletedTask)
            {
                InheritedSecret = value => value == "synthetic-known-secret-value",
            };
            var result = await manager.ExecuteAsync("main/owned", new JsonObject
            {
                ["command"] = "printf '%s|%s\\n' \"${FOXWARM_SECRET_PROBE-unset}\" \"$FOXWARM_ENV_PROBE\"; FOXWARM_SECRET_PROBE=explicit /bin/bash -c 'printf \"%s\\n\" \"$FOXWARM_SECRET_PROBE\"'",
                ["timeout"] = 10,
            }, default);
            Assert.Null(result["error"]);
            Assert.Contains("unset|ordinary value\nexplicit\n", result["output"]!.ToString());
            Assert.Equal("synthetic-known-secret-value", Environment.GetEnvironmentVariable("FOXWARM_SECRET_PROBE"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_SECRET_PROBE", previous);
        }
    }

    [Fact]
    public async Task Cli_exec_passes_clean_environment_to_its_native_launch_boundary()
    {
        using var temp = new TempDirectory();
        using var environment = new HostEnvironment(temp.Path);
        var observed = false;
        await using var manager = new NodeExecManager(new NodePaths(temp.Path), Path.Combine(temp.Path, "running.json"), (_, _, _) => Task.CompletedTask)
        {
            Launch = start =>
            {
                observed = true;
                Assert.False(start.Environment.ContainsKey("TMUX"));
                Assert.False(start.Environment.ContainsKey("TMUX_PANE"));
                Assert.Equal(temp.Path, start.Environment["TMUX_TMPDIR"]);
                Assert.Equal("ordinary value", start.Environment["FOXWARM_ENV_PROBE"]);
                throw new IOException("fixture stops before native launch");
            },
        };
        await Assert.ThrowsAsync<IOException>(() => manager.Start(new JsonObject
        {
            ["sessionId"] = "main/owned",
            ["backgroundExecId"] = "quiet-otter",
            ["args"] = new JsonObject { ["command"] = Probe },
        }, "main", "owned", default, () => { }));
        Assert.True(observed);
        environment.AssertUnchanged(temp.Path);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Main_and_cli_real_terminals_start_without_host_tmux_context(bool cli)
    {
        if ((!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) || !TerminalNative.IsSupported)
            return;
        using var temp = new TempDirectory();
        using var environment = new HostEnvironment(temp.Path);
        var output = Path.Combine(temp.Path, "environment.txt");
        var command = Probe + " > " + ExecNative.Quote(output) + "\n";
        if (cli)
        {
            await using var service = new NodePtyService(temp.Path);
            var owner = new object();
            JsonObject? response = null;
            await service.Dispatch("create", new JsonObject { ["cwd"] = temp.Path }, owner, value =>
            {
                response = value;
                return Task.CompletedTask;
            });
            await service.Dispatch("input", new JsonObject
            {
                ["terminalId"] = response!["terminal"]!["id"]!.ToString(),
                ["data"] = command,
            }, owner, _ => Task.CompletedTask);
            await AssertProbe(output, temp.Path);
        }
        else
        {
            await using var registry = new TerminalRegistry(temp.Path, CancellationToken.None);
            var terminal = await registry.CreateAsync(temp.Path, 80, 24, CancellationToken.None);
            await terminal.InputAsync(command);
            await AssertProbe(output, temp.Path);
        }
        environment.AssertUnchanged(temp.Path);
    }

    private static async Task AssertProbe(string path, string root)
    {
        var expected = "unset\nunset\nordinary value\n" + root + "\n";
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!File.Exists(path) || await File.ReadAllTextAsync(path) != expected)
            await Task.Delay(20, deadline.Token);
        Assert.Equal(expected, await File.ReadAllTextAsync(path));
    }
}
