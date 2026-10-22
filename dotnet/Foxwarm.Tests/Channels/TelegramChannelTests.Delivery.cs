using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class TelegramChannelTests
{
    [Fact]
    public async Task File_fanout_reports_delivered_send_only_no_file_and_missing_targets_and_isolated_explicit_sends_require_own_attachment()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject
            {
                ["alpha"] = ExternalChannelFixture.Channel(),
                ["beta"] = ExternalChannelFixture.Channel("b"),
            },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        f.Manager.AttachChannel("alpha:42", f.Owner);
        f.Manager.AttachChannel(
            "beta:42",
            f.Owner,
            updates: new JsonObject { ["mode"] = "send-only" }
        );
        f.Manager.ChannelRegistry.Register("text-only", (_, _, _) => Task.CompletedTask);
        f.Manager.AttachChannel("text-only:42", f.Owner);
        f.Manager.AttachChannel("missing:42", f.Owner);
        f.Manager.AttachWebUi(f.Owner.Id, f.Owner);
        f.Manager.RegisterWebUiFileDelivery((_, _, _) => { });
        var path = Path.Combine(f.Work, "fanout.txt");
        await File.WriteAllTextAsync(path, "file bytes");
        var sent = await f.ToolAsync("send_file", new JsonObject { ["filePath"] = path });
        Assert.Null(sent!["error"]);
        var output = SessionWait.Text(sent["output"])!;
        Assert.Contains("Delivered: 2", output);
        Assert.Contains("beta:42` (send-only)", output);
        Assert.Contains("text-only:42` (no file support)", output);
        Assert.Contains("missing:42", output);
        Assert.Single(peer.Sent("a", "sendDocument"));
        Assert.Empty(peer.Sent("b", "sendDocument"));
        Assert.NotNull(sent["fileDelivery"]);
        Assert.NotNull(
            (
                await f.ToolAsync(
                    "send_file",
                    new JsonObject { ["filePath"] = path, ["channelTargetId"] = "text-only:42" }
                )
            )!["error"]
        );

        f.Manager.Nodes.Registry.Create("owned-fixture-node");
        await f.Manager.SetAgentIsolationAsync(
            "main",
            "owned-fixture-node",
            true,
            new JsonArray(
                new JsonObject
                {
                    ["effect"] = "allow",
                    ["source"] = "builtin",
                    ["tool"] = "send_to_channel",
                },
                new JsonObject
                {
                    ["effect"] = "allow",
                    ["source"] = "builtin",
                    ["tool"] = "send_file",
                }
            )
        );
        Assert.NotNull(
            (
                await f.ToolAsync(
                    "send_to_channel",
                    new JsonObject
                    {
                        ["channelTargetId"] = "alpha:99",
                        ["message"] = "unattached denied",
                    }
                )
            )!["error"]
        );
        Assert.Null(
            (
                await f.ToolAsync(
                    "send_to_channel",
                    new JsonObject
                    {
                        ["channelTargetId"] = "alpha:42",
                        ["message"] = "own attachment",
                    }
                )
            )!["error"]
        );
        Assert.Null(
            (
                await f.ToolAsync(
                    "send_file",
                    new JsonObject
                    {
                        ["filePath"] = path,
                        ["node"] = "master",
                        ["channelTargetId"] = "alpha:42",
                    }
                )
            )!["error"]
        );
        Assert.NotNull(
            (
                await f.ToolAsync(
                    "send_file",
                    new JsonObject
                    {
                        ["filePath"] = path,
                        ["node"] = "master",
                        ["channelTargetId"] = "alpha:99",
                    }
                )
            )!["error"]
        );
        Assert.DoesNotContain(
            peer.Sent("a"),
            call => SessionWait.Text(call.Body["text"]) == "unattached denied"
        );
    }

    [Fact]
    public async Task Reload_restarts_unchanged_managed_instances_preserves_nonmanaged_registry_and_reports_partial_starts_and_unsupported_adapters()
    {
        await using var peer = await TelegramPeer.StartAsync();
        var config = ExternalChannelFixture.Channel();
        config["mainAttachUser"] = "11";
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = config },
            dependencies: peer.Dependencies
        );
        var transient = new List<string>();
        f.Manager.ChannelRegistry.Register(
            "mcp-context",
            (_, text, _) =>
            {
                transient.Add(text);
                return Task.CompletedTask;
            }
        );
        f.Manager.ChannelRegistry.Register(
            "webui",
            (_, text, _) =>
            {
                transient.Add("webui:" + text);
                return Task.CompletedTask;
            }
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        Assert.Equal("main", SessionWait.Text(f.Manager.ChannelBinding("alpha:11")!["sessionId"]));
        Assert.Null(f.Manager.Catalog.Get("main"));
        f.Manager.AttachChannel("alpha:11", f.Owner);
        peer.Fail = call =>
            call.Bot == "bad" && call.Method == "setMyCommands"
                ? (401, "invalid fixture token")
                : null;
        var channels = new JsonObject
        {
            ["alpha"] = config.DeepClone(),
            ["broken"] = ExternalChannelFixture.Channel("bad"),
            ["later"] = new JsonObject
            {
                ["type"] = "fixture-unsupported",
                ["webhookUrl"] = "http://127.0.0.1:1/fixture",
            },
        };
        var result = await f.Configuration.SaveAppAsync(
            new JsonObject { ["channels"] = channels.DeepClone() }.ToJsonString()
        );
        Assert.True(SessionCatalog.Flag(result["saved"]));
        Assert.Contains(
            "channels.broken",
            result["notApplied"]!.AsArray().Select(SessionWait.Text)
        );
        Assert.Contains("channels.later", result["notApplied"]!.AsArray().Select(SessionWait.Text));
        Assert.DoesNotContain(
            "channels.later",
            result["restartRequired"]!.AsArray().Select(SessionWait.Text)
        );
        Assert.Equal(
            2,
            peer.Calls.Count(call => call.Bot == "a" && call.Method == "setMyCommands")
        );
        Assert.Equal(
            f.Owner.Id,
            SessionWait.Text(f.Manager.ChannelBinding("alpha:11")!["sessionId"])
        );
        await f.Manager.ChannelRegistry.SendAsync("mcp-context:reply", "survived", default);
        await f.Manager.ChannelRegistry.SendAsync("webui:any", "still registered", default);
        Assert.Equal(new[] { "survived", "webui:still registered" }, transient);
        Assert.Null(f.Manager.ChannelBinding("mcp-context:reply"));
        var statuses = f
            .Configuration.ChannelDiagnostics(true)
            .OfType<JsonObject>()
            .ToDictionary(row => SessionWait.Text(row["channelId"])!);
        Assert.True(SessionCatalog.Flag(statuses["alpha"]["running"]));
        Assert.False(SessionCatalog.Flag(statuses["broken"]["running"]));
        Assert.NotNull(statuses["broken"]["lastError"]);
        Assert.False(SessionCatalog.Flag(statuses["later"]["managed"]));
        var candidate = Path.Combine(f.Work, "candidate.yaml");
        await File.WriteAllTextAsync(candidate, f.Configuration.ReadCurrentAppRaw());
        var installed = await f.ToolAsync(
            "set_config",
            new JsonObject { ["target"] = "config", ["filePath"] = candidate }
        );
        Assert.Null(installed!["error"]);
        var toolResult = JsonNode.Parse(SessionWait.Text(installed["output"])!)!;
        Assert.True(SessionCatalog.Flag(toolResult["saved"]));
        Assert.NotNull(toolResult["reload"]);
        Assert.Equal(
            3,
            peer.Calls.Count(call => call.Bot == "a" && call.Method == "setMyCommands")
        );
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            f.Manager.ManagedChannels.ChangeAsync("restart", "later")
        );
    }
}
