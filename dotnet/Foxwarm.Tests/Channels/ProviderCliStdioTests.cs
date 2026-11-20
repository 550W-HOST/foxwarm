using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

// The official CLI Node binary in `--stdio` mode: directly over a pipe, and behind a Provider
// whose connect only hands the pipe to it, driven by Main's real Code and Terminal routes.
public sealed class ProviderCliStdioTests
{
    private static string Cli => Path.Combine(AppContext.BaseDirectory, "Foxwarm.CliNode");

    private sealed class Pipe : IAsyncDisposable
    {
        internal readonly Process Process;
        private readonly Task<string?> firstLine;
        private readonly StreamReader lines;

        internal Pipe(params string[] arguments)
        {
            var info = new ProcessStartInfo(Cli)
            {
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var argument in arguments)
                info.ArgumentList.Add(argument);
            Process = Process.Start(info)!;
            _ = Process.StandardError.ReadToEndAsync();
            lines = Process.StandardOutput;
            firstLine = lines.ReadLineAsync();
        }

        internal async Task<JsonObject> Ready() =>
            JsonNode.Parse((await firstLine.WaitAsync(TimeSpan.FromSeconds(20)))!)!.AsObject();

        internal async Task Send(JsonObject frame)
        {
            await Process.StandardInput.WriteLineAsync(frame.ToJsonString());
            await Process.StandardInput.FlushAsync();
        }

        internal async Task<JsonObject> Next(Func<JsonObject, bool>? match = null)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            while (true)
            {
                var line = await lines.ReadLineAsync(deadline.Token);
                Assert.NotNull(line);
                var frame = JsonNode.Parse(line!)!.AsObject();
                if (match is null || match(frame))
                    return frame;
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (!Process.HasExited)
                Process.Kill(true);
            await Process.WaitForExitAsync();
            Process.Dispose();
        }
    }

    private static JsonObject Request(
        string service,
        string operation,
        JsonObject args,
        string id
    ) =>
        new()
        {
            ["type"] = "node_service_request",
            ["requestId"] = id,
            ["service"] = service,
            ["operation"] = operation,
            ["args"] = args,
        };

    [Fact]
    public async Task Stdio_mode_announces_services_and_answers_only_service_frames()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        await using var pipe = new Pipe("--stdio");
        var ready = await pipe.Ready();
        Assert.Equal("node_stdio_ready", ready["type"]!.ToString());
        Assert.Equal(1, ready["services"]!["vscode-fs"]!.GetValue<int>());
        Assert.Equal(2, ready["services"]!["vscode-git"]!.GetValue<int>());
        Assert.Equal(1, ready["services"]!["vscode-pty"]!.GetValue<int>());
        await pipe.Send(Request("vscode-fs", "stat", new() { ["path"] = temp.Path }, "r1"));
        var stat = await pipe.Next();
        Assert.Equal("node_service_response", stat["type"]!.ToString());
        Assert.Equal("r1", stat["requestId"]!.ToString());
        Assert.Equal(2, stat["result"]!["type"]!.GetValue<int>());
        await pipe.Send(Request("vscode-fs", "stat", new() { ["path"] = "relative" }, "r2"));
        var failure = await pipe.Next();
        Assert.Equal("node_service_error", failure["type"]!.ToString());
        Assert.Equal("r2", failure["requestId"]!.ToString());
        Assert.NotEmpty(failure["error"]!["code"]!.ToString());
        // A one-way command to an unknown service operation reports through an event, not a reply.
        await pipe.Send(
            new JsonObject
            {
                ["type"] = "node_service_command",
                ["service"] = "vscode-pty",
                ["operation"] = "input",
                ["args"] = new JsonObject { ["terminalId"] = "missing", ["data"] = "x" },
            }
        );
        var error = await pipe.Next();
        Assert.Equal("node_service_event", error["type"]!.ToString());
        Assert.Equal("missing", error["event"]!["terminalId"]!.ToString());
        pipe.Process.StandardInput.Close();
        await pipe.Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(0, pipe.Process.ExitCode);
    }

    [Theory]
    [InlineData("tool_call", "exec")]
    [InlineData("node_service_request", "exec")]
    [InlineData("hello", "vscode-fs")]
    public async Task Stdio_mode_rejects_model_tool_exec_and_unknown_frames_and_ends(
        string type,
        string service
    )
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var marker = Path.Combine(temp.Path, "must-not-exist");
        await using var pipe = new Pipe("--stdio");
        await pipe.Ready();
        await pipe.Send(
            new JsonObject
            {
                ["type"] = type,
                ["callId"] = "c1",
                ["requestId"] = "r1",
                ["tool"] = "exec",
                ["service"] = service,
                ["operation"] = "run",
                ["args"] = new JsonObject { ["command"] = "touch " + marker },
            }
        );
        await pipe.Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(2, pipe.Process.ExitCode);
        Assert.False(File.Exists(marker));
        Assert.Null(await pipe.Process.StandardOutput.ReadLineAsync());
    }

    [Fact]
    public async Task Stdio_mode_rejects_other_options_and_never_connects_out()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var pipe = new Pipe("--stdio", "--host", "http://127.0.0.1:1");
        await pipe.Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(1, pipe.Process.ExitCode);
        Assert.Null(await pipe.Process.StandardOutput.ReadLineAsync());
    }

    [Fact]
    public async Task Closing_stdin_ends_the_process_and_its_terminals()
    {
        if (!OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        await using var pipe = new Pipe("--stdio");
        await pipe.Ready();
        await pipe.Send(
            Request(
                "vscode-pty",
                "create",
                new()
                {
                    ["cwd"] = temp.Path,
                    ["cols"] = 80,
                    ["rows"] = 24,
                },
                "c"
            )
        );
        var created = await pipe.Next(frame =>
            frame["type"]?.ToString() == "node_service_response"
        );
        var shell = created["result"]!["terminal"]!["pid"]!.GetValue<int>();
        Assert.True(Directory.Exists("/proc/" + shell));
        pipe.Process.StandardInput.Close();
        await pipe.Process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Equal(0, pipe.Process.ExitCode);
        for (var attempt = 0; attempt < 100 && Directory.Exists("/proc/" + shell); attempt++)
            await Task.Delay(100);
        // A reaped zombie leaves /proc until its parent collects it; the parent is gone, so it is reparented.
        Assert.False(
            Directory.Exists("/proc/" + shell)
                && !File.ReadAllText("/proc/" + shell + "/stat").Contains(") Z "),
            "The terminal shell outlived the stdio process."
        );
    }

    [Fact]
    public async Task Code_files_and_Git_through_a_Provider_that_only_pipes_to_the_CLI_Node()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ProviderCodeServicesTests.Fixture.Create("cli-stdio", Cli);
        var file = Path.Combine(f.Work, "src", "main.txt");
        var created = await f.Client.PostAsync(
            f.Fs("create-directory", Path.GetDirectoryName(file)!),
            new StringContent("{}", Encoding.UTF8, "application/json")
        );
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        using var write = new HttpRequestMessage(
            HttpMethod.Put,
            f.Fs("write-file", file) + "&create=1"
        )
        {
            Content = new ByteArrayContent("one\n"u8.ToArray()),
        };
        Assert.True((await f.Client.SendAsync(write)).IsSuccessStatusCode);
        Assert.Equal("one\n", await f.Client.GetStringAsync(f.Fs("read-file", file)));
        var missing = await f.Client.GetAsync(f.Fs("stat", file + ".none"));
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        var listing = await f.Json(await f.Client.GetAsync(f.Fs("read-directory", f.Work)));
        Assert.Equal("src", listing["entries"]![0]!["name"]!.ToString());
        // Real CLI Git service including immutable commit details (version 2).
        foreach (
            var arguments in new[]
            {
                new[] { "init", "-q", "-b", "main" },
                ["add", "-A"],
                [
                    "-c",
                    "user.name=T",
                    "-c",
                    "user.email=t@example.invalid",
                    "commit",
                    "-q",
                    "-m",
                    "first",
                ],
            }
        )
        {
            var info = new ProcessStartInfo("git") { WorkingDirectory = f.Work };
            foreach (var argument in arguments)
                info.ArgumentList.Add(argument);
            using var git = Process.Start(info)!;
            await git.WaitForExitAsync();
            Assert.Equal(0, git.ExitCode);
        }
        await File.WriteAllTextAsync(file, "two\n");
        var status = await f.Json(await f.Client.GetAsync(f.Git("status", f.Work)));
        Assert.Contains(
            status["changes"]!.AsArray(),
            c => c!["path"]!.ToString().EndsWith("main.txt")
        );
        Assert.Equal(
            "one\n",
            await f.Client.GetStringAsync(f.Git("content", f.Work, "&path=src/main.txt&side=base"))
        );
        var head = new ProcessStartInfo("git", ["rev-parse", "HEAD"])
        {
            WorkingDirectory = f.Work,
            RedirectStandardOutput = true,
        };
        using var parse = Process.Start(head)!;
        var hash = (await parse.StandardOutput.ReadToEndAsync()).Trim();
        await parse.WaitForExitAsync();
        var commit = await f.Json(await f.Client.GetAsync(f.Git("commit", f.Work, "&id=" + hash)));
        Assert.Contains("first", commit.ToJsonString());
        Assert.Equal(1, f.Count("connect"));
        // 50 MiB crosses the pipe in one frame in both directions.
        var bytes = RandomNumberGenerator.GetBytes(50 * 1024 * 1024);
        var large = Path.Combine(f.Work, "large.bin");
        using var upload = new HttpRequestMessage(
            HttpMethod.Put,
            f.Fs("write-file", large) + "&create=1"
        )
        {
            Content = new ByteArrayContent(bytes),
        };
        var uploaded = await f.Client.SendAsync(upload);
        Assert.True(uploaded.IsSuccessStatusCode, await uploaded.Content.ReadAsStringAsync());
        Assert.Equal(SHA256.HashData(bytes), SHA256.HashData(await File.ReadAllBytesAsync(large)));
        Assert.Equal(
            SHA256.HashData(bytes),
            SHA256.HashData(await f.Client.GetByteArrayAsync(f.Fs("read-file", large)))
        );
        Assert.Equal(1, f.Count("connect"));
    }

    [Fact]
    public async Task Terminals_and_the_code_helper_work_through_the_CLI_pipe_and_end_with_the_generation()
    {
        if (!OperatingSystem.IsLinux())
            return;
        await using var f = await ProviderCodeServicesTests.Fixture.Create("cli-stdio", Cli);
        var terminal = await ProviderTerminalServicesTests.Create(f, "fixture/svc");
        var id = terminal["id"]!.ToString();
        Assert.StartsWith("pn.", id);
        var target = Path.Combine(f.Work, "open-me.txt");
        await File.WriteAllTextAsync(target, "hello\n");
        await using (
            var stream = await ProviderTerminalServicesTests.Stream.Open(f, id, control: true)
        )
        {
            await stream.Until(frame => frame["type"]?.ToString() == "ready");
            await stream.Send(new { type = "input", data = "echo pty-$((6*7))\n" });
            await stream.UntilOutput("pty-42");
            await stream.Send(
                new
                {
                    type = "resize",
                    cols = 132,
                    rows = 41,
                }
            );
            await stream.Send(new { type = "input", data = "stty size\n" });
            await stream.UntilOutput("41 132");
            // The optional `code` helper reaches the browser as a control request for this Node.
            await stream.Send(new { type = "input", data = $"code {target}; echo helper-done\n" });
            var control = await stream.Until(frame => frame["type"]?.ToString() == "control");
            Assert.Equal("open", control["command"]!.ToString());
            Assert.Equal("fixture/svc", control["request"]!["nodeId"]!.ToString());
            Assert.Equal(target, control["request"]!["path"]!.ToString());
            await stream.Send(
                new
                {
                    type = "control-result",
                    requestId = control["requestId"]!.ToString(),
                    ok = true,
                    message = "opened",
                }
            );
            await stream.UntilOutput("helper-done");
        }
        // Killing the provider process ends the generation; the CLI and its terminals end with it.
        var pid = File.ReadAllLines(Path.Combine(f.Target, "channel.jsonl"))
            .Select(line => JsonNode.Parse(line)!.AsObject())
            .Single(entry => entry.ContainsKey("connect"));
        var cliPid = pid["cliPid"]!.GetValue<int>();
        using (var kill = Process.Start("kill", ["-9", pid["pid"]!.ToString()])!)
            await kill.WaitForExitAsync();
        for (var attempt = 0; attempt < 100 && Directory.Exists("/proc/" + cliPid); attempt++)
            await Task.Delay(100);
        Assert.False(
            Directory.Exists("/proc/" + cliPid)
                && !File.ReadAllText("/proc/" + cliPid + "/stat").Contains(") Z "),
            "The CLI Node outlived its pipe."
        );
        var gone = await f.Client.GetAsync("/api/terminals/" + Uri.EscapeDataString(id));
        Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
        Assert.Equal(2, f.Count("connect"));
    }
}
