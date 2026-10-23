using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class CanonicalEntryTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Console_starts_from_another_cwd_without_experiment_roots_and_headless_has_no_listener(
        bool headless
    )
    {
        if (OperatingSystem.IsWindows())
            return; // This executable/cwd/signal fixture qualifies the Unix console path.
        using var temp = new TempDirectory();
        var app = Path.Combine(temp.Path, "installed application");
        var cwd = Path.Combine(temp.Path, "unrelated shell directory");
        var data = Path.Combine(app, "selected data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(cwd);
        await File.WriteAllTextAsync(Path.Combine(app, "data_dir"), " selected data \n");
        await File.WriteAllTextAsync(Path.Combine(cwd, "data_dir"), "wrong tree");
        var port = FreePort();
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            $"""
            bot:
              httpPort: {port}
              enableWebUI: {(!headless).ToString().ToLowerInvariant()}
              enableTrigger: {(!headless).ToString().ToLowerInvariant()}
            paths:
              agentsDir: 'configured agents'
              skillsDir: 'configured skills'
              mcpConfigPath: 'outbound/mcp.json'
            """
        );
        var start = new ProcessStartInfo(
            Path.Combine(Environment.GetEnvironmentVariable("DOTNET_ROOT")!, "dotnet")
        )
        {
            WorkingDirectory = cwd,
            ArgumentList = { typeof(HttpServer).Assembly.Location, "--installation-root", app },
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
        start.Environment["FOXWARM_APP_ROOT"] = cwd; // Retired inherited setting cannot select state.
        using var process = Process.Start(start)!;
        var error = process.StandardError.ReadToEndAsync();
        var ready = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var output = Task.Run(async () =>
        {
            var lines = new List<string>();
            while (await process.StandardOutput.ReadLineAsync() is { } line)
            {
                lines.Add(line);
                if (
                    line.StartsWith("Main HTTP listening:", StringComparison.Ordinal)
                    || line == "Main started without HTTP."
                )
                    ready.TrySetResult(line);
            }
            return string.Join('\n', lines);
        });
        try
        {
            await Task.WhenAny(ready.Task, process.WaitForExitAsync())
                .WaitAsync(TimeSpan.FromSeconds(20));
            Assert.True(
                ready.Task.IsCompletedSuccessfully,
                process.HasExited ? await output + await error : "No startup notification"
            );
            Assert.False(Directory.Exists(Path.Combine(cwd, "state")));
            Assert.False(Directory.Exists(Path.Combine(cwd, "wrong tree")));
            Assert.True(Directory.Exists(Path.Combine(app, "configured agents", "main", "memory")));
            Assert.False(Directory.Exists(Path.Combine(data, "agents")));
            if (headless)
            {
                Assert.Equal("Main started without HTTP.", await ready.Task);
                using var socket = new TcpClient();
                await Assert.ThrowsAsync<SocketException>(() =>
                    socket.ConnectAsync(IPAddress.Loopback, port)
                );
                Assert.False(File.Exists(Path.Combine(data, "state", "token")));
                using var signal = Process.Start("kill", ["-TERM", process.Id.ToString()])!;
                await signal.WaitForExitAsync();
                Assert.Equal(0, signal.ExitCode);
            }
            else
            {
                var token = await File.ReadAllTextAsync(Path.Combine(data, "state", "token"));
                using var client = new HttpClient
                {
                    BaseAddress = new Uri($"http://127.0.0.1:{port}"),
                };
                client.DefaultRequestHeaders.Authorization = new("Bearer", token);
                Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health")).StatusCode);
                var roots = (
                    await client.GetFromJsonAsync<JsonObject>("/api/vscode-web/fs/workspace-roots")
                )!;
                Assert.Equal(app, roots["roots"]!["app"]!["path"]!.GetValue<string>());
                Assert.Equal(data, roots["roots"]!["data"]!["path"]!.GetValue<string>());
                Assert.Equal(
                    Path.Combine(data, "state", "config.yaml"),
                    roots["configFiles"]!["app"]!["path"]!.GetValue<string>()
                );
                Assert.Equal(
                    HttpStatusCode.BadRequest,
                    (
                        await client.PostAsJsonAsync(
                            "/trigger",
                            new { text = "must not create main" }
                        )
                    ).StatusCode
                );
                Assert.Equal(
                    HttpStatusCode.Accepted,
                    (await client.PostAsync("/admin/shutdown", null)).StatusCode
                );
            }
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(15));
            Assert.Equal(0, process.ExitCode);
            Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "main.json")));
            Assert.False(Directory.Exists(Path.Combine(app, "memory")));
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill();
                await process.WaitForExitAsync();
            }
            await output;
            await error;
        }
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}
