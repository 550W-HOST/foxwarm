using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class StartupDiagnosticsTests
{
    [Theory]
    [InlineData("normal")]
    [InlineData("stderr")]
    [InlineData("failed-file")]
    public async Task Main_capture_completes_mixed_console_writers_and_flushes_owned_records(
        string mode
    )
    {
        if (mode == "failed-file" && !OperatingSystem.IsLinux())
            return;
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        await File.WriteAllTextAsync(Path.Combine(state, "config.yaml"), "vector: false\n");
        var logPath = Path.Combine(state, "logs", "foxwarm.log");
        if (mode == "failed-file")
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            File.CreateSymbolicLink(logPath, "/dev/full");
        }
        var start = new ProcessStartInfo(
            Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")!, "dotnet")
        )
        {
            WorkingDirectory = temp.Path,
            ArgumentList =
            {
                Path.Combine(AppContext.BaseDirectory, "Foxwarm.DevTools.dll"),
                "mainlog-fixture",
                temp.Path,
                mode,
            },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (
            var key in start
                .Environment.Keys.Where(key =>
                    key.StartsWith("FOXWARM_", StringComparison.Ordinal)
                    || key is "CONFIG_PATH" or "MCP_CONFIG_PATH" or "ASPNETCORE_URLS"
                )
                .ToArray()
        )
            start.Environment.Remove(key);
        start.Environment["FOXWARM_DATA_DIR"] = temp.Path;
        if (mode == "stderr")
            start.Environment["FOXWARM_LOG_STDERR"] = "1";
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Equal(0, process.ExitCode);
            var output = (await stdout).Replace("\r\n", "\n");
            var errors = (await stderr).Replace("\r\n", "\n");
            var ordinary = Enumerable
                .Range(0, 10000)
                .Select(index => "ordinary startup " + index);
            var diagnostics = Enumerable
                .Range(0, 10000)
                .SelectMany(index => new[]
                {
                    "timer diagnostic " + index,
                    "   at supported delivery",
                });
            if (mode == "stderr")
                Assert.Empty(output);
            else
                Assert.Equal(
                    string.Join('\n', ordinary) + "\npartial stdoutretained stdout\n",
                    output
                );
            if (mode == "failed-file")
            {
                Assert.Contains("Main file logging failed:", errors);
                Assert.Equal(
                    Enumerable.Range(0, 10000).Select(index => "timer diagnostic " + index).Order(),
                    Regex.Matches(errors, @"timer diagnostic \d+").Select(match => match.Value).Order()
                );
                Assert.Equal(10000, Regex.Matches(errors, "   at supported delivery").Count);
                Assert.Contains("partial stderr", errors);
                Assert.EndsWith("retained stderr\n", errors);
                return;
            }
            var tail =
                mode == "stderr"
                    ? "partial stdoutpartial stderrretained stdout\nretained stderr\n"
                    : "partial stderrretained stderr\n";
            Assert.EndsWith(tail, errors);
            const string consoleMessage = @"ordinary startup \d+|timer diagnostic \d+|   at supported delivery";
            var prefix = errors[..^tail.Length];
            Assert.Equal(
                (mode == "stderr" ? ordinary.Concat(diagnostics) : diagnostics).Order(),
                Regex.Matches(prefix, consoleMessage).Select(match => match.Value).Order()
            );
            Assert.Equal(
                new string('\n', mode == "stderr" ? 30000 : 20000),
                Regex.Replace(prefix, consoleMessage, "")
            );
            Assert.Equal(
                "30000",
                await File.ReadAllTextAsync(Path.Combine(temp.Path, "completed-records"))
            );
            var records = File.ReadLines(logPath)
                .Select(line => line[(line.IndexOf("] ", StringComparison.Ordinal) + 2)..])
                .ToArray();
            Assert.Equal(
                ordinary
                    .Select(line => "INFO: " + line)
                    .Concat(diagnostics.Select(line => "ERROR: " + line))
                    .Order(),
                records[..^2].Order()
            );
            Assert.Equal(
                new[] { "INFO: partial stdout", "ERROR: partial stderr" },
                records[^2..]
            );
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill();
                await process.WaitForExitAsync();
            }
            await stdout;
            await stderr;
        }
    }

    [Theory]
    [InlineData("occupied-http")]
    [InlineData("catalog")]
    [InlineData("configuration")]
    public async Task Canonical_fatal_startup_is_nonzero_and_recorded_before_capture_is_disposed(
        string failure
    )
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        await File.WriteAllTextAsync(
            Path.Combine(state, "config.yaml"),
            failure == "configuration"
                ? "channels: [secret-invalid-value]\n"
                : "vector: false\nchannels: {}\n"
        );
        if (failure == "catalog")
            Directory.CreateDirectory(Path.Combine(state, "catalog.sqlite"));
        using var occupied = new TcpListener(IPAddress.Loopback, 0);
        occupied.Start();
        var start = new ProcessStartInfo(
            Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")!, "dotnet")
        )
        {
            WorkingDirectory = temp.Path,
            ArgumentList = { typeof(MainHost).Assembly.Location },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (
            var key in start
                .Environment.Keys.Where(key =>
                    key.StartsWith("FOXWARM_", StringComparison.Ordinal)
                    || key is "CONFIG_PATH" or "MCP_CONFIG_PATH" or "ASPNETCORE_URLS"
                )
                .ToArray()
        )
            start.Environment.Remove(key);
        start.Environment["FOXWARM_DATA_DIR"] = temp.Path;
        start.Environment["FOXWARM_AGENTS_DIR"] = Path.Combine(temp.Path, "agents");
        await File.AppendAllTextAsync(
            Path.Combine(state, "config.yaml"),
            $"bot: {{httpPort: {((IPEndPoint)occupied.LocalEndpoint).Port}}}\n"
        );
        start.Environment["FOXWARM_SYNC_FILE_LOG"] = "1";
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        try
        {
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
            Assert.NotEqual(0, process.ExitCode);
            Assert.Empty(await stdout);
            var error = await stderr;
            Assert.DoesNotContain("secret-invalid-value", error);
            Assert.DoesNotContain("Unhandled exception", error);
            var logPath = Path.Combine(state, "logs", "foxwarm.log");
            if (failure == "configuration")
            {
                Assert.False(File.Exists(logPath));
                Assert.Contains("InvalidDataException", error);
                return;
            }
            var records = File.ReadLines(logPath)
                .Select(line => JsonNode.Parse(line)!.AsObject())
                .ToArray();
            var fatal = Assert.Single(records, row => row["level"]!.GetValue<int>() >= 50);
            Assert.Contains(
                failure == "catalog" ? "IOException" : "AddressAlreadyInUse",
                fatal["msg"]!.ToString()
            );
            var stop = Array.FindIndex(
                records,
                row =>
                    row["msg"]!.ToString().Contains("stopped", StringComparison.OrdinalIgnoreCase)
            );
            Assert.True(stop < 0 || Array.IndexOf(records, fatal) < stop);
            Assert.DoesNotContain(
                "secret-invalid-value",
                string.Join('\n', records.Select(row => row.ToJsonString()))
            );
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill();
                await process.WaitForExitAsync();
            }
            await stdout;
            await stderr;
        }
    }

    [Fact]
    public async Task WS_lifecycle_keeps_cli_stdout_clean_and_Main_classifies_routine_and_failure_events()
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            "vector: false\n"
        );
        var configuration = new ModelConfiguration(temp.Path);
        var originalOut = Console.Out;
        var originalError = Console.Error;
        var sync = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG");
        using var output = new StringWriter();
        using var errors = new StringWriter();
        await using var transport = new ResponsesWsTransport();
        using var socket = new ClientWebSocket();
        using var invoker = new HttpMessageInvoker(new SocketsHttpHandler());
        var resource = new ResponsesWsResource(transport, socket, "fixture", invoker);
        try
        {
            Console.SetOut(output);
            Console.SetError(errors);
            transport.Log(resource, "dispatch", "fresh");
            Assert.Empty(output.ToString());
            Assert.Equal("dispatch", JsonNode.Parse(errors.ToString())!["boundary"]!.ToString());
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", "1");
            using (var log = new MainLog(configuration))
            {
                transport.Log(resource, "dispatch", "fresh");
                transport.Log(resource, "completion", "response-completed");
                resource.Abort("receive-failure");
            }
            var records = File.ReadLines(MainLog.Destination(configuration))
                .Select(line => JsonNode.Parse(line)!.AsObject())
                .ToArray();
            Assert.Equal(
                new[] { 30, 30, 50 },
                records.Select(row => row["level"]!.GetValue<int>())
            );
            Assert.Equal(
                new[] { "dispatch", "completion", "discard" },
                records.Select(row =>
                    JsonNode.Parse(row["msg"]!.ToString())!["boundary"]!.ToString()
                )
            );
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }

    [Theory]
    [InlineData(false, 1000, 30)]
    [InlineData(false, 1002, 50)]
    [InlineData(true, 1000, 50)]
    public async Task Actual_WS_close_acknowledgement_is_routine_only_for_normal_idle_close(
        bool active,
        int code,
        int expectedLevel
    )
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            "vector: false\n"
        );
        var configuration = new ModelConfiguration(temp.Path);
        await using var peer = await WsPeer.StartAsync();
        peer.CloseReplyStatus = (WebSocketCloseStatus)code;
        if (active)
            peer.CloseAfterRequest = (WebSocketCloseStatus)code;
        await using var transport = new ResponsesWsTransport();
        var service = new ResponsesWsChatService(
            ResponsesWsTests.Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "diagnostics"
        );
        var sync = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", "1");
            using (var log = new MainLog(configuration))
            {
                var request = service.ChatAsync(
                    "fixture",
                    [ResponsesWsTests.Message("user", "fixture")],
                    default
                );
                if (active)
                    await Assert.ThrowsAsync<IOException>(() =>
                        request.WaitAsync(TimeSpan.FromSeconds(5))
                    );
                else
                {
                    var result = await request.WaitAsync(TimeSpan.FromSeconds(5));
                    result.FinalizeHistory([result.AssistantMessage!]);
                    Assert.Equal(1, transport.IdleCount);
                }
                await transport.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            }
            var records = File.ReadLines(MainLog.Destination(configuration))
                .Select(line => JsonNode.Parse(line)!.AsObject())
                .ToArray();
            var close = Assert.Single(
                records,
                row =>
                    JsonNode.Parse(row["msg"]!.ToString())!["cause"]!.ToString() == "upstream-close"
                    && JsonNode.Parse(row["msg"]!.ToString())!["boundary"]!.ToString() == "close"
            );
            Assert.Equal(expectedLevel, close["level"]!.GetValue<int>());
            Assert.Equal(
                code,
                JsonNode.Parse(close["msg"]!.ToString())!["closeCode"]!.GetValue<int>()
            );
            if (!active)
                Assert.Equal(1000, Assert.Single(peer.CloseCodes));
            if (expectedLevel == 30)
                Assert.DoesNotContain(records, row => row["level"]!.GetValue<int>() >= 50);
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Actual_WS_timeout_is_an_error_but_caller_cancellation_is_ordinary_lifecycle(
        bool cancel
    )
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            "vector: false\n"
        );
        var configuration = new ModelConfiguration(temp.Path);
        await using var peer = await WsPeer.StartAsync();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.BeforeResponse = async _ =>
        {
            reached.TrySetResult();
            await release.Task;
        };
        var clock = new ManualWsClock();
        await using var transport = new ResponsesWsTransport(clock);
        var service = new ResponsesWsChatService(
            ResponsesWsTests.Options(peer.Uri),
            transport,
            ModelRequestScope.Canonical,
            false,
            "diagnostics"
        );
        using var caller = new CancellationTokenSource();
        var sync = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG");
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", "1");
            using (var log = new MainLog(configuration))
            {
                var request = service.ChatAsync(
                    "fixture",
                    [ResponsesWsTests.Message("user", "fixture")],
                    caller.Token
                );
                await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
                if (cancel)
                    caller.Cancel();
                else
                    clock.Advance(TimeSpan.FromSeconds(181));
                var error = await Record.ExceptionAsync(() =>
                    request.WaitAsync(TimeSpan.FromSeconds(5))
                );
                Assert.NotNull(error);
                Assert.True(request.IsCompleted);
            }
            var discard = File.ReadLines(MainLog.Destination(configuration))
                .Select(line => JsonNode.Parse(line)!.AsObject())
                .Single(row =>
                    JsonNode.Parse(row["msg"]!.ToString())!["boundary"]!.ToString() == "discard"
                );
            Assert.Equal(cancel ? 30 : 50, discard["level"]!.GetValue<int>());
        }
        finally
        {
            release.TrySetResult();
            caller.Cancel();
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }
}
