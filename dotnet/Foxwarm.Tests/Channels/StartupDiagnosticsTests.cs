using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class StartupDiagnosticsTests
{
    [Theory]
    [InlineData("occupied-http")]
    [InlineData("catalog")]
    [InlineData("configuration")]
    public async Task Canonical_fatal_startup_is_nonzero_and_recorded_before_capture_is_disposed(string failure)
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        await File.WriteAllTextAsync(Path.Combine(state, "config.yaml"), failure == "configuration"
            ? "channels: [secret-invalid-value]\n"
            : "vector: false\nchannels: {}\n");
        if (failure == "catalog")
            Directory.CreateDirectory(Path.Combine(state, "catalog.sqlite"));
        using var occupied = new TcpListener(IPAddress.Loopback, 0);
        occupied.Start();
        var start = new ProcessStartInfo(Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")!, "dotnet"))
        {
            WorkingDirectory = temp.Path,
            ArgumentList = { typeof(MainHost).Assembly.Location },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var key in start.Environment.Keys.Where(key => key.StartsWith("FOXWARM_", StringComparison.Ordinal)
            || key is "CONFIG_PATH" or "MCP_CONFIG_PATH" or "ASPNETCORE_URLS").ToArray())
            start.Environment.Remove(key);
        start.Environment["FOXWARM_APP_ROOT"] = temp.Path;
        start.Environment["FOXWARM_DATA_DIR"] = temp.Path;
        start.Environment["FOXWARM_AGENTS_DIR"] = Path.Combine(temp.Path, "agents");
        start.Environment["FOXWARM_HTTP_PORT"] = ((IPEndPoint)occupied.LocalEndpoint).Port.ToString();
        start.Environment["FOXWARM_BIND_ADDRESS"] = "127.0.0.1";
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
            var records = File.ReadLines(logPath).Select(line => JsonNode.Parse(line)!.AsObject()).ToArray();
            var fatal = Assert.Single(records, row => row["level"]!.GetValue<int>() >= 50);
            Assert.Contains(failure == "catalog" ? "IOException" : "AddressAlreadyInUse", fatal["msg"]!.ToString());
            var stop = Array.FindIndex(records, row => row["msg"]!.ToString().Contains("stopped", StringComparison.OrdinalIgnoreCase));
            Assert.True(stop < 0 || Array.IndexOf(records, fatal) < stop);
            Assert.DoesNotContain("secret-invalid-value", string.Join('\n', records.Select(row => row.ToJsonString())));
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
        await File.WriteAllTextAsync(Path.Combine(temp.Path, "state", "config.yaml"), "vector: false\n");
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
                .Select(line => JsonNode.Parse(line)!.AsObject()).ToArray();
            Assert.Equal(new[] { 30, 30, 50 }, records.Select(row => row["level"]!.GetValue<int>()));
            Assert.Equal(new[] { "dispatch", "completion", "discard" }, records.Select(row =>
                JsonNode.Parse(row["msg"]!.ToString())!["boundary"]!.ToString()));
        }
        finally
        {
            Console.SetOut(originalOut);
            Console.SetError(originalError);
            Environment.SetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG", sync);
        }
    }
}
