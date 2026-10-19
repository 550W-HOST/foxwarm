using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class SessionCommandEffectsTests
{
    [Fact]
    public async Task Verbose_real_turn_starts_only_authorized_unskipped_tools_without_history_or_delivery_ACK_dependency()
    {
        await using var peer = new ConcurrentPeer(
            2,
            async (index, stream, _) =>
            {
                if (index == 1)
                {
                    await SendAsync(stream, "done");
                    return;
                }
                var output = new JsonArray(
                    ProviderCall(
                        "write",
                        new JsonObject
                        {
                            ["filePath"] = "allowed.txt",
                            ["content"] = "actual effect",
                        }
                    ),
                    ProviderCall("read", new JsonObject { ["filePath"] = "denied.txt" }),
                    ProviderCall(
                        "write",
                        new JsonObject
                        {
                            ["filePath"] = "cancelled.txt",
                            ["content"] = "no",
                            ["__cancelTool"] = true,
                        }
                    )
                );
                output[1]!["call_id"] = "denied";
                output[2]!["call_id"] = "cancelled";
                var invalid = ProviderCall("write", new JsonObject());
                invalid["call_id"] = "malformed";
                invalid["arguments"] = "{broken";
                output.Add(invalid);
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        "data: "
                            + new JsonObject
                            {
                                ["type"] = "response.completed",
                                ["response"] = new JsonObject
                                {
                                    ["id"] = "verbose-test",
                                    ["output"] = output,
                                },
                            }.ToJsonString()
                            + "\n\n"
                    )
                );
            }
        );
        await using var f = await FixtureAsync(provider: peer.Uri);
        var policy = Path.Combine(f.Data, "state", "tool-authorization.yaml");
        await File.WriteAllTextAsync(
            policy,
            "version: 1\nrules: [{id: deny-read, action: deny, match: {tool: {source: node, name: read}}}]\n"
        );
        f.Manager.Authorization.Invalidate();
        var delivered = new List<(string Target, string Text, ChannelSendOptions Options)>();
        var pendingDelivery = Signal();
        foreach (var instance in new[] { "normal", "push", "webui" })
            f.Manager.ChannelRegistry.Register(
                instance,
                new RegisteredChannel(
                    instance,
                    (conversation, text, options, _) =>
                    {
                        delivered.Add((instance + ":" + conversation, text, options));
                        return pendingDelivery.Task;
                    }
                )
            );
        f.Manager.AttachChannel("normal:c", f.Owner);
        f.Manager.AttachChannel(
            "push:c",
            f.Owner,
            updates: new JsonObject { ["mode"] = "send-only" }
        );
        f.Manager.AttachChannel("webui:c", f.Owner);
        try
        {
            await CommandAsync(f, "/verbose on");
            Assert.True(f.Owner.Entry.Snapshot().AuthorityEnvelope["verbose"]!.GetValue<bool>());
            Assert.Empty(delivered);
            var saved = await f.Owner.AuthorityStore.LoadAsync(f.Owner.Id);
            Assert.True(saved!.AuthorityEnvelope["verbose"]!.GetValue<bool>());
            var before = f.Owner.History().Count;
            await f.Owner.Registry.Ingress.EnqueueAsync(
                f.Owner.Id,
                QueueItem.UserText("run tools")
            );
            await f.Owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(10));
            var verbose = Assert.Single(delivered, item => item.Text.StartsWith("🛠"));
            Assert.Equal("normal:c", verbose.Target);
            Assert.Contains("allowed.txt", verbose.Text);
            Assert.Null(verbose.Options.ParseMode);
            Assert.False(verbose.Options.TurnFinal);
            Assert.DoesNotContain(
                delivered,
                item => item.Target.StartsWith("push:") || item.Target.StartsWith("webui:")
            );
            Assert.Equal(
                "actual effect",
                await File.ReadAllTextAsync(
                    Path.Combine(f.Manager.AgentDirectory("main"), "allowed.txt")
                )
            );
            Assert.False(
                File.Exists(Path.Combine(f.Manager.AgentDirectory("main"), "cancelled.txt"))
            );
            Assert.Equal(before + 4, f.Owner.History().Count);
            Assert.DoesNotContain(
                "🛠",
                string.Join('\n', f.Owner.History().Select(row => row.ToJsonString()))
            );
            var responses = f.Owner.History().Single(row => row["role"]?.ToString() == "tool")[
                "parts"
            ]!.AsArray();
            Assert.Equal(4, responses.Count);
            Assert.Contains("tool_authorization_denied", responses.ToJsonString());
            Assert.Contains("cancel", responses.ToJsonString());
            Assert.DoesNotContain("🛠", peer.Requests.Last()["input"]!.ToJsonString());
            var preview = await SourceAsync(
                new JsonObject
                {
                    ["operation"] = "preview",
                    ["call"] = new JsonObject
                    {
                        ["name"] = "write",
                        ["args"] = new JsonObject
                        {
                            ["filePath"] = "allowed.txt",
                            ["content"] = "actual effect",
                        },
                    },
                }
            );
            Assert.Equal("🛠 *[write]*: `" + preview["preview"] + "`", verbose.Text);
            delivered.Clear();
            await CommandAsync(f, "/verbose off");
            await CommandAsync(f, "/verbose");
            await f.ToolAsync(
                "write",
                new JsonObject { ["filePath"] = "off.txt", ["content"] = "off" }
            );
            Assert.Empty(delivered);
            Assert.False(
                (await f.Owner.AuthorityStore.LoadAsync(f.Owner.Id))!.AuthorityEnvelope[
                    "verbose"
                ]!.GetValue<bool>()
            );
        }
        finally
        {
            pendingDelivery.TrySetResult();
        }
    }

    [Fact]
    public async Task Btw_result_uses_ordinary_non_WebUI_fanout_excludes_send_only_and_does_not_wait_for_ACK()
    {
        await using var peer = new ConcurrentPeer(
            1,
            (_, stream, _) => SendAsync(stream, "broadcast result")
        );
        await using var f = await FixtureAsync(provider: peer.Uri);
        var sent = new List<(string Target, ChannelSendOptions Options)>();
        var pending = Signal();
        foreach (var instance in new[] { "normal", "push", "webui" })
            f.Manager.ChannelRegistry.Register(
                instance,
                new RegisteredChannel(
                    instance,
                    (conversation, _, options, _) =>
                    {
                        sent.Add((instance + ":" + conversation, options));
                        return pending.Task;
                    }
                )
            );
        f.Manager.AttachChannel("normal:c", f.Owner);
        f.Manager.AttachChannel(
            "push:c",
            f.Owner,
            updates: new JsonObject { ["mode"] = "send-only" }
        );
        f.Manager.AttachChannel("webui:c", f.Owner);
        try
        {
            await f.Manager.RunBtwAsync(f.Owner, "answer").WaitAsync(TimeSpan.FromSeconds(10));
            var delivery = Assert.Single(sent);
            Assert.Equal("normal:c", delivery.Target);
            Assert.Null(delivery.Options.ParseMode);
            Assert.False(delivery.Options.TurnFinal);
            Assert.Null(delivery.Options.PresentationTurnId);
            Assert.Single(f.Owner.History());
        }
        finally
        {
            pending.TrySetResult();
        }
    }
}
