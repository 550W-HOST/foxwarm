using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class ManagedStartupTests
{
    [Fact]
    public async Task Stop_owns_the_original_initializer_and_never_publishes_it_after_a_late_versions_reply()
    {
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var replied = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (!call.Path.EndsWith("/versions", StringComparison.Ordinal))
                return null;
            reached.TrySetResult();
            await release.Task;
            replied.TrySetResult();
            return Results.Json(new { versions = new[] { "v1.4" } });
        };
        await using var f = await ExternalChannelFixture.CreateAsync(new JsonObject { ["alpha"] = peer.Matrix() });
        var channels = f.Manager.ManagedChannels!;
        var startup = channels.ReloadAsync();
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await channels.StopIngressAsync().WaitAsync(TimeSpan.FromSeconds(5));
            var outcome = await startup.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Empty(outcome["started"]!.AsArray());
            Assert.Null(f.Manager.ChannelRegistry.Get("alpha"));
            Assert.Null(f.Manager.ChannelBinding("alpha:@bot:fixture"));
            Assert.False(release.Task.IsCompleted);
            release.TrySetResult();
            await replied.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Null(f.Manager.ChannelRegistry.Get("alpha"));
            Assert.DoesNotContain(peer.Calls, call => call.Path.EndsWith("/sync", StringComparison.Ordinal) || call.Path.EndsWith("/capabilities", StringComparison.Ordinal));
            await Assert.ThrowsAsync<InvalidOperationException>(() => channels.ReloadAsync());
        }
        finally
        {
            release.TrySetResult();
            await startup;
        }
    }

    [Fact]
    public async Task Background_control_stop_reaches_ordinary_Main_shutdown_during_real_channel_startup()
    {
        using var temp = new TempDirectory();
        await using var peer = await ExternalProtocolPeer.StartAsync();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        peer.Respond = async call =>
        {
            if (!call.Path.EndsWith("/versions", StringComparison.Ordinal))
                return null;
            reached.TrySetResult();
            await release.Task;
            return Results.Json(new { versions = new[] { "v1.4" } });
        };
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), new JsonObject { ["vector"] = false, ["channels"] = new JsonObject { ["alpha"] = peer.Matrix() } }.ToJsonString());
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync([], data, work, new ModelConfiguration(data), settings, null);
        var name = "foxwarm-startup-test-" + Guid.NewGuid().ToString("N");
        var previous = Environment.GetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE");
        WindowsBackgroundControl control;
        try
        {
            Environment.SetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE", name);
            // Exercise the real protocol owner with .NET's available local named-pipe seam.
            // The production Windows-only Program/Start gate is not changed or qualified here.
            control = (WindowsBackgroundControl)Activator.CreateInstance(typeof(WindowsBackgroundControl), BindingFlags.Instance | BindingFlags.NonPublic, null, [data, host.Lifetime], null)!;
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE", previous);
        }
        await using var ownedControl = control;
        async Task<JsonObject> Command(string command)
        {
            var script = Path.GetFullPath("../../../../../scripts/windowsService.js", AppContext.BaseDirectory);
            var address = OperatingSystem.IsWindows() ? @"\\.\pipe\" + name : Path.Combine(Path.GetTempPath(), "CoreFxPipe_" + name);
            var start = new ProcessStartInfo("node")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                ArgumentList =
                {
                    "-e",
                    "require(process.argv[1]).requestControl(process.argv[2], process.argv[3]).then(value => console.log(JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });",
                    script,
                    address,
                    command,
                },
            };
            using var client = Process.Start(start)!;
            var output = client.StandardOutput.ReadToEndAsync();
            var error = client.StandardError.ReadToEndAsync();
            await client.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(client.ExitCode == 0, await error);
            return JsonNode.Parse(await output)!.AsObject();
        }
        var startup = host.StartAsync();
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var status = await Command("status");
            Assert.Equal(Environment.ProcessId, status["pid"]!.GetValue<int>());
            Assert.False(status["stopping"]!.GetValue<bool>());
            Assert.Equal(Path.Combine(data, "state", "logs", "foxwarm.stdout.log"), status["stdoutLog"]!.GetValue<string>());
            Assert.True((await Command("stop"))["ok"]!.GetValue<bool>());
            await host.WaitForShutdownAsync().WaitAsync(TimeSpan.FromSeconds(5));
            await startup.WaitAsync(TimeSpan.FromSeconds(5));
            using var http = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
            http.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
            using var refused = await http.PostAsJsonAsync("api/sessions", new { agentId = "main", sessionId = "after-control-stop" });
            Assert.False(refused.IsSuccessStatusCode);
            Assert.True((await Command("status"))["stopping"]!.GetValue<bool>());
            await host.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(release.Task.IsCompleted);
            Assert.True((await Command("status"))["stopping"]!.GetValue<bool>());
        }
        finally
        {
            release.TrySetResult();
            await startup;
        }
    }
}
