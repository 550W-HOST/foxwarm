using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ClaudeRuntimeTests
{
    private static async Task<JsonObject> AvailabilityAsync(InboundMcpFixture f)
    {
        f.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            InboundMcpFixture.Admin
        );
        var status = await f.Http.GetFromJsonAsync<JsonObject>(
            f.Url.Replace("/mcp", "/api/setup/status")
        );
        return status!["capabilities"]!["claudeCode"]!.AsObject();
    }

    [Fact]
    public async Task Availability_checks_default_PATH_and_execute_access_without_invoking_a_launcher()
    {
        await using var f = await InboundMcpFixture.CreateAsync(webUiEnabled: true);
        var bin = Path.Combine(f.Temp.Path, "bin");
        Directory.CreateDirectory(bin);
        File.CreateSymbolicLink(Path.Combine(bin, "setsid"), "/usr/bin/setsid");
        var path = Environment.GetEnvironmentVariable("PATH");
        var launcher = Path.Combine(bin, "custom wrapper");
        var marker = Path.Combine(bin, "invoked");
        await File.WriteAllTextAsync(launcher, "#!/bin/sh\nprintf invoked > '" + marker + "'\n");
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException();
        try
        {
            Environment.SetEnvironmentVariable("PATH", bin);
            Assert.False((await AvailabilityAsync(f))["available"]!.GetValue<bool>());
            File.CreateSymbolicLink(Path.Combine(bin, "claude"), launcher);
            Assert.False((await AvailabilityAsync(f))["available"]!.GetValue<bool>());
            File.SetUnixFileMode(launcher, UnixFileMode.UserRead | UnixFileMode.UserExecute);
            Assert.True((await AvailabilityAsync(f))["available"]!.GetValue<bool>());
            Assert.Null((await AvailabilityAsync(f))["reason"]);
            Assert.False(File.Exists(marker));
            File.Delete(launcher);
            Directory.CreateDirectory(launcher);
            Assert.False((await AvailabilityAsync(f))["available"]!.GetValue<bool>());
            File.Delete(Path.Combine(bin, "setsid"));
            Assert.Contains("setsid", (await AvailabilityAsync(f))["reason"]!.GetValue<string>());
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", path);
        }
    }

    [Fact]
    public async Task Availability_uses_active_wrapper_configuration_not_saved_restart_pending_settings()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(webUiEnabled: true);
        Assert.True((await AvailabilityAsync(f.Main))["available"]!.GetValue<bool>());
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "inputs.jsonl")));
        var app = f.Main.Configuration.AppConfiguration;
        app["claudeCode"]!["executable"] = Path.Combine(f.Temp.Path, "missing-wrapper");
        var saved = await f.Main.Configuration.SaveAppAsync(app.ToJsonString());
        Assert.Contains(
            "claudeCode",
            saved["restartRequired"]!.AsArray().Select(v => v!.GetValue<string>())
        );
        Assert.True((await AvailabilityAsync(f.Main))["available"]!.GetValue<bool>());
        File.Delete(Path.Combine(f.Temp.Path, "claude-peer"));
        Assert.False((await AvailabilityAsync(f.Main))["available"]!.GetValue<bool>());
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "inputs.jsonl")));
    }

    [Fact]
    public async Task Missing_listener_is_reported_before_any_launch_or_input_checkpoint()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(startHttpServer: false);
        var config = ClaudeRuntimeConfiguration.Capture(f.Main.Configuration.AppConfiguration);
        Assert.Contains("HTTP listener", config.UnavailableReason(f.Main.Manager));
        await f.RunAsync();
        Assert.IsType<ClaudeRuntimeException>(f.Owner.Entry.LastBackgroundProcessorFailure);
        Assert.Null(f.Owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]!["sessionId"]);
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "inputs.jsonl")));
    }

    [Fact]
    public async Task Unavailable_launcher_does_not_change_HTTP_or_tool_creation_semantics()
    {
        await using var f = await ClaudeRuntimeFixture.CreateAsync(webUiEnabled: true);
        File.Delete(Path.Combine(f.Temp.Path, "claude-peer"));
        Assert.False((await AvailabilityAsync(f.Main))["available"]!.GetValue<bool>());
        using var response = await f.Main.Http.PostAsJsonAsync(
            f.Main.Url.Replace("/mcp", "/api/sessions"),
            new
            {
                agentId = "main",
                sessionId = "unavailable-http",
                runtime = "claude-code",
            }
        );
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var executor = f.Main.Target.Registry.HostFor(f.Main.Target.Id).RuntimeTools;
        foreach (var name in new[] { "create_session", "create_child_session" })
        {
            var args =
                name == "create_session"
                    ? new JsonObject
                    {
                        ["agentName"] = "main",
                        ["sessionName"] = "unavailable-tool",
                    }
                    : new JsonObject { ["suffix"] = "unavailable-child" };
            args["runtime"] = "claude-code";
            var result = await executor.ExecuteAsync(
                new JsonObject { ["name"] = name, ["args"] = args },
                CancellationToken.None
            );
            Assert.Null(result!["error"]);
        }
        foreach (
            var id in new[] { "unavailable-http", "unavailable-tool", "target_unavailable-child" }
        )
        {
            var owner = f.Main.Manager.Find(id)!;
            Assert.Equal("claude-code", owner.Metadata().Runtime);
            Assert.Equal(
                "new",
                owner.Entry.Snapshot().AuthorityEnvelope["externalRuntime"]![
                    "status"
                ]!.GetValue<string>()
            );
        }
        Assert.False(File.Exists(Path.Combine(f.PeerDirectory, "inputs.jsonl")));
    }
}
