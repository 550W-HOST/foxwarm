using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class ModelConfigurationInstallationTests
{
    [Fact]
    public async Task Weixin_login_preserves_numeric_identity_strings_progress_numbers_and_complete_JSON_app_documents()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(temp.Path);
        var channels = new JsonObject
        {
            ["alpha"] = new JsonObject
            {
                ["type"] = "telegram",
                ["allowedUsers"] = new JsonArray("11"),
                ["mainAttachUser"] = "42",
                ["channelProgress"] = new JsonObject { ["intervalMs"] = 30000 },
            },
        };
        await configuration.SaveAppAsync(
            "channels:\n  alpha:\n    type: telegram\n    allowedUsers: ['11']\n    mainAttachUser: '42'\n    channelProgress: {intervalMs: 30000}\n# between channel entries\n  weixin: {enabled: false, token: old-token}\n\n# retained following section\nother: {preserve: true}\n"
        );
        var settings = configuration.WeixinSettings(new JsonObject { ["channelId"] = "weixin" });
        await configuration.SaveWeixinLoginAsync(
            settings,
            new(true, "confirmed", "synthetic-login-token", "11"),
            setup: true
        );
        var block = ConfigurationYaml.Parse(configuration.ReadCurrentAppRaw(), "config");
        Assert.Equal("synthetic-login-token", block["channels"]!["weixin"]!["token"]!.GetValue<string>());
        Assert.Equal(2, block["channels"]!.AsObject().Count);
        Assert.Contains("# retained following section\nother: {preserve: true}", configuration.ReadCurrentAppRaw());
        Assert.Equal("11", block["channels"]!["alpha"]!["allowedUsers"]![0]!.GetValue<string>());
        Assert.Equal("42", block["channels"]!["alpha"]!["mainAttachUser"]!.GetValue<string>());
        Assert.Equal(
            30000d,
            block["channels"]!["alpha"]!["channelProgress"]!["intervalMs"]!.GetValue<double>()
        );
        await configuration.SaveAppAsync(
            new JsonObject
            {
                ["channels"] = channels.DeepClone(),
                ["unrelated"] = new JsonObject { ["retained"] = true },
            }.ToJsonString()
        );
        await configuration.SaveWeixinLoginAsync(
            settings,
            new(true, "confirmed", "synthetic-login-token", "11"),
            setup: true
        );
        var json = JsonNode.Parse(configuration.ReadCurrentAppRaw())!;
        Assert.True(json["unrelated"]!["retained"]!.GetValue<bool>());
        Assert.Equal("11", json["channels"]!["alpha"]!["allowedUsers"]![0]!.GetValue<string>());
    }

    [Fact]
    public async Task Queued_Weixin_login_reads_the_latest_installed_document_inside_the_shared_lane()
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state/config.yaml"),
            "llm:\n  maxOutput: 713\nchannels:\n  webui: {}\n"
        );
        var configuration = new ModelConfiguration(temp.Path);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var raw =
            "# latest unrelated comment\r\nllm:\r\n  maxOutput: 714\r\nchannels:\r\n  webui: {}\r\n";
        var first = configuration.InstallAsync(
            "config",
            async _ =>
            {
                entered.SetResult();
                await release.Task;
                return Encoding.UTF8.GetBytes(raw);
            }
        );
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var section = configuration.SaveWeixinLoginAsync(
            configuration.WeixinSettings(new JsonObject { ["channelId"] = "weixin" }),
            new(true, "confirmed", "synthetic-login-token", "11"),
            setup: true
        );
        Assert.False(section.IsCompleted);
        release.SetResult();
        var installed = await first;
        await section;
        var current = await File.ReadAllTextAsync(configuration.AppPath);
        Assert.Contains("# latest unrelated comment", current);
        Assert.Contains("maxOutput: 714", current);
        Assert.Contains("synthetic-login-token", current);
        var parsed = ConfigurationYaml.Parse(current, "app config");
        Assert.Equal(714d, parsed["llm"]!["maxOutput"]!.GetValue<double>());
        Assert.Contains(
            "llm",
            installed["restartRequired"]!.AsArray().Select(value => value!.GetValue<string>())
        );
        Assert.Equal(713, configuration.MaxOutput);
    }

    [Fact]
    public async Task Whole_document_install_preserves_exact_bytes_and_failed_validation_keeps_the_active_catalog()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(temp.Path);
        var raw = Encoding
            .UTF8.GetPreamble()
            .Concat(
                Encoding.UTF8.GetBytes(
                    "# retained comment\r\ndefault: local/wire\r\nproviders:\r\n  local:\r\n    providerType: openai-responses\r\n    baseUrl: http://127.0.0.1:1\r\n    models: [wire]\r\n"
                )
            )
            .ToArray();
        var installed = await configuration.InstallAsync("models", _ => Task.FromResult(raw));
        Assert.Equal(raw, await File.ReadAllBytesAsync(configuration.ActivePath));
        Assert.Equal("local/wire", configuration.Capture().DefaultKey);
        Assert.Equal("models", Assert.Single(installed["applied"]!.AsArray())!.GetValue<string>());
        foreach (
            var invalid in new[]
            {
                Encoding.UTF8.GetBytes("providers: null\ndefault: missing\n"),
                new byte[] { 0xff, 0xfe },
            }
        )
        {
            await Assert.ThrowsAnyAsync<Exception>(() =>
                configuration.InstallAsync("models", _ => Task.FromResult(invalid))
            );
            Assert.Equal(raw, await File.ReadAllBytesAsync(configuration.ActivePath));
            Assert.Equal("local/wire", configuration.Capture().DefaultKey);
        }
        if (!OperatingSystem.IsWindows())
            Assert.Equal(
                UnixFileMode.UserRead | UnixFileMode.UserWrite,
                File.GetUnixFileMode(configuration.ActivePath)
            );
    }
}
