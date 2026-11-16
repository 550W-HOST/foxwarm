using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using static Foxwarm.Tests.OperationEffectConformance;

namespace Foxwarm.Tests;

// A channel.send operation names the conversation the transport delivers to: each transport's
// canonical conversation, computed by the function its delivery uses.
public sealed class ChannelConversationTests
{
    private static Task Policy(ExternalChannelFixture f, string yaml) =>
        f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(yaml), default);

    private static string? Error(JsonNode? result) => SessionWait.Text(result?["error"]?["type"]);

    private static JsonObject Send(string target, string message = "fixture") =>
        new() { ["channelTargetId"] = target, ["message"] = message };

    private static async Task<string> FileAsync(ExternalChannelFixture f)
    {
        var path = Path.Combine(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory, "delivered.txt");
        await File.WriteAllTextAsync(path, "file fixture");
        return path;
    }

    [Fact]
    public async Task Telegram_spellings_of_a_chat_are_that_chat()
    {
        await using var peer = await TelegramPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await Policy(f, "version: 1\nrules:\n- {op: channel.send, channel: 'alpha:123', action: deny}\n");
        var path = await FileAsync(f);
        foreach (var target in new[] { "alpha:123", "alpha:123 ", "alpha:0123", "alpha:123x", "alpha:+123", "alpha: 123" })
        {
            Assert.Equal("tool_authorization_denied", Error(await f.ToolAsync("send_to_channel", Send(target))));
            Assert.Equal(
                "tool_authorization_denied",
                Error(await f.ToolAsync("send_file", new JsonObject { ["channelTargetId"] = target, ["filePath"] = path }))
            );
        }
        Assert.Empty(peer.Calls.Where(call => call.Method.StartsWith("send", StringComparison.Ordinal)));
        Assert.Null(Error(await f.ToolAsync("send_to_channel", Send("alpha:0124"))));
        Assert.Equal("124", peer.Sent("a").Single().Body["chat_id"]!.ToJsonString().Trim('"'));
    }

    [Fact]
    public async Task QQ_padded_ids_are_the_trimmed_conversation()
    {
        await using var peer = await QQBotPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["qq"] = peer.Config() },
            dependencies: peer.Dependencies
        );
        await QQBotChannelTests.Start(f, peer);
        await Policy(f, "version: 1\nrules:\n- {op: channel.send, channel: 'qq:group:room', action: deny}\n");
        foreach (var target in new[] { "qq:group:room", "qq:group: room", "qq:group:room ", "qq:group:\troom\n" })
            Assert.Equal("tool_authorization_denied", Error(await f.ToolAsync("send_to_channel", Send(target))));
        Assert.Empty(peer.Sent);
        Assert.Null(Error(await f.ToolAsync("send_to_channel", Send("qq:group: other "))));
        Assert.EndsWith("/v2/groups/other/messages", peer.Sent.Single().Path);
    }

    [Fact]
    public async Task WeWork_webhook_conversations_without_a_chat_are_the_default_destination()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(WeWorkPeer.Port(), stream: false) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => f.Manager.ChannelRegistry.Get("work") is not null);
        await Policy(f, "version: 1\nrules:\n- {op: channel.send, channel: 'work:/default-webhook', action: deny}\n");
        var path = await FileAsync(f);
        foreach (var target in new[] { "work:alice", "work:bob", "work:wrong-chat" })
        {
            Assert.Equal("tool_authorization_denied", Error(await f.ToolAsync("send_to_channel", Send(target))));
            Assert.Equal(
                "tool_authorization_denied",
                Error(await f.ToolAsync("send_file", new JsonObject { ["channelTargetId"] = target, ["filePath"] = path }))
            );
        }
        // A padded chat would reach the default destination over the webhook: unknown, so rejected.
        Assert.Equal("tool_authorization_unresolved", Error(await f.ToolAsync("send_to_channel", Send("work: wokchat"))));
        Assert.Empty(peer.Calls.Where(call => call.Path.EndsWith("/webhook", StringComparison.Ordinal)));
        Assert.Null(Error(await f.ToolAsync("send_to_channel", Send("work:wokchat"))));
        var posted = peer.Calls.Single(call => call.Path.EndsWith("/webhook", StringComparison.Ordinal));
        Assert.Equal("wokchat", SessionWait.Text(JsonNode.Parse(posted.Bytes)!["chatid"]));
    }

    [Fact]
    public async Task WeWork_streamed_webhook_text_to_a_conversation_is_unknown_before_delivery()
    {
        await using var peer = await WeWorkPeer.StartAsync();
        await using var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(WeWorkPeer.Port(), stream: true) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        await TelegramChannelTests.Until(() => f.Manager.ChannelRegistry.Get("work") is not null);
        await Policy(f, "version: 1\ndefaultAction: deny\nrules:\n- {op: channel.send, channel: 'work:*', action: allow}\n");
        var files = new WorkspaceTools(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory);
        var assessment = await f.Manager.AssessToolAsync(f.Owner, f.Registry.Resolve("send_to_channel", Send("work:alice")), files, default);
        Assert.Null(Assert.Single(assessment.Request.Operations ?? []).Resources["channel"]);
        Assert.Equal("tool_authorization_unresolved", Error(await f.ToolAsync("send_to_channel", Send("work:alice"))));
        Assert.Null(Error(await f.ToolAsync("send_to_channel", Send("work:wokchat"))));
        // A file never joins a stream: the default destination.
        var file = await f.Manager.AssessToolAsync(
            f.Owner,
            f.Registry.Resolve("send_file", new JsonObject { ["channelTargetId"] = "work:alice", ["filePath"] = await FileAsync(f) }),
            files,
            default
        );
        Assert.Equal(
            "work:" + WeWorkChannel.DefaultWebhookConversation,
            SessionWait.Text(file.Request.Operations!.Single(operation => operation.Op == "channel.send").Resources["channel"])
        );
    }

    // Differential conformance: the declared channel.send resource against the conversation the
    // transport's test double received, for canonical, variant and padded spellings.
    private sealed record Transport(
        string Name,
        Func<Task<(ExternalChannelFixture Fixture, IAsyncDisposable Peer, Func<IEnumerable<Effect>> Delivered)>> Start,
        string[] Targets
    );

    private static IEnumerable<Effect> Deliveries(string instance, IEnumerable<string> conversations) =>
        conversations.Select(conversation =>
            new Effect("channel.send", new JsonObject { ["channel"] = instance + ":" + conversation })
        );

    private static readonly Dictionary<string, Transport> Transports = new()
    {
        ["telegram"] = new(
            "telegram",
            async () =>
            {
                var peer = await TelegramPeer.StartAsync();
                var f = await ExternalChannelFixture.CreateAsync(
                    new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() },
                    dependencies: peer.Dependencies
                );
                await f.Manager.ManagedChannels!.ReloadAsync();
                var start = peer.Calls.Count;
                return (
                    f,
                    peer,
                    () =>
                        Deliveries(
                            "alpha",
                            peer.Calls.Skip(start)
                                .Where(call => call.Method is "sendMessage" or "sendDocument" or "sendPhoto")
                                .Select(call => SessionWait.Text(call.Body["chat_id"]) ?? call.Body["chat_id"]!.ToJsonString())
                        )
                );
            },
            ["alpha:123", "alpha:-100", "alpha:123 ", "alpha:0123", "alpha:123x", "alpha:+123", "alpha: 123", "alpha:chat"]
        ),
        ["qq"] = new(
            "qq",
            async () =>
            {
                var peer = await QQBotPeer.StartAsync();
                var f = await ExternalChannelFixture.CreateAsync(new() { ["qq"] = peer.Config() }, dependencies: peer.Dependencies);
                await QQBotChannelTests.Start(f, peer);
                var start = peer.Calls.Count;
                return (
                    f,
                    peer,
                    () =>
                        Deliveries(
                            "qq",
                            peer.Calls.Skip(start)
                                .Where(call => call.Path.EndsWith("/messages", StringComparison.Ordinal))
                                .Select(call =>
                                {
                                    var parts = call.Path.Split('/', StringSplitOptions.RemoveEmptyEntries);
                                    var id = Uri.UnescapeDataString(parts[^2]);
                                    return parts[0] switch
                                    {
                                        "v2" => (parts[1] == "users" ? "c2c" : "group") + ":" + id,
                                        "channels" => "guild:" + id,
                                        _ => "dm:" + id,
                                    };
                                })
                        )
                );
            },
            ["qq:group:room", "qq:group: room", "qq:c2c:user ", "qq:guild:\tchannel", "qq:other:room"]
        ),
        ["wework webhook"] = new(
            "wework webhook",
            () => WeWork(stream: false, socket: false),
            ["work:wokchat", "work:wrkchat", "work:alice", "work: wokchat", "work:wokchat ", "work:/default-webhook"]
        ),
        ["wework streamed webhook"] = new(
            "wework streamed webhook",
            () => WeWork(stream: true, socket: false),
            ["work:wokchat", "work:alice"]
        ),
        ["wework socket"] = new(
            "wework socket",
            () => WeWork(stream: false, socket: true),
            ["work:alice", "work:wokchat", "work:alice ", "work:/default-webhook"]
        ),
        ["verbatim"] = new(
            "verbatim",
            async () =>
            {
                var f = await ExternalChannelFixture.CreateAsync();
                var delivered = new System.Collections.Concurrent.ConcurrentQueue<string>();
                f.Manager.ChannelRegistry.Register(
                    "plain",
                    new RegisteredChannel(
                        "plain",
                        (conversation, _, _, _) =>
                        {
                            delivered.Enqueue(conversation);
                            return Task.CompletedTask;
                        },
                        SendFile: (conversation, _, _, _) =>
                        {
                            delivered.Enqueue(conversation);
                            return Task.CompletedTask;
                        }
                    )
                );
                return (f, new Nothing(), () => Deliveries("plain", delivered));
            },
            ["plain:room", "plain:room ", "plain: room", "missing:room"]
        ),
    };

    private sealed class Nothing : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private static async Task<(ExternalChannelFixture, IAsyncDisposable, Func<IEnumerable<Effect>>)> WeWork(bool stream, bool socket)
    {
        var peer = await WeWorkPeer.StartAsync();
        var f = await ExternalChannelFixture.CreateAsync(
            new() { ["work"] = peer.Config(WeWorkPeer.Port(), stream: stream, socket: socket) },
            dependencies: peer.Dependencies
        );
        await f.Manager.ManagedChannels!.ReloadAsync();
        if (socket)
            await TelegramChannelTests.Until(() =>
                peer.Frames.Any(frame => SessionWait.Text(frame["cmd"]) == "aibot_subscribe")
            );
        else
            await TelegramChannelTests.Until(() => f.Manager.ChannelRegistry.Get("work") is not null);
        var calls = peer.Calls.Count;
        var frames = peer.Frames.Count;
        return (
            f,
            peer,
            () =>
                Deliveries(
                    "work",
                    peer.Calls.Skip(calls)
                        .Where(call => call.Path.EndsWith("/webhook", StringComparison.Ordinal))
                        .Select(call =>
                            SessionWait.Text(JsonNode.Parse(call.Bytes)!["chatid"]) ?? WeWorkChannel.DefaultWebhookConversation
                        )
                        .Concat(
                            peer.Frames.Skip(frames)
                                .Where(frame => SessionWait.Text(frame["cmd"]) == "aibot_send_msg")
                                .Select(frame => SessionWait.Text(frame["body"]?["chatid"])!)
                        )
                        // A file sends its caption and the file: one delivery per target.
                        .Distinct()
                )
        );
    }

    public static TheoryData<string, string, bool> ChannelCases()
    {
        var data = new TheoryData<string, string, bool>();
        foreach (var (name, transport) in Transports)
            foreach (var target in transport.Targets)
                foreach (var file in new[] { false, true })
                    if (!(file && name == "wework socket"))
                        data.Add(name, target, file);
        return data;
    }

    // Each spelling, then each padded variant of the whole target, in a fresh fixture, through
    // the differential harness: the handler must reject a call without delivery or deliver to
    // exactly the declared target. Streamed webhook text to a conversation is unknown before
    // delivery (deferred).
    [Theory]
    [MemberData(nameof(ChannelCases))]
    public async Task Channel_operations_name_the_conversation_delivered_to(string transport, string target, bool file)
    {
        var tool = file ? "send_file" : "send_to_channel";
        var @case = new Case(
            transport + " " + tool + " " + target,
            tool,
            file ? new JsonObject { ["channelTargetId"] = target } : Send(target),
            Deferred: transport == "wework streamed webhook" && !file ? ["channel.send:channel"] : null,
            MayReject: true
        );
        var problems = new List<string>();
        foreach (var variant in new[] { @case }.Concat(Padded(@case)))
        {
            var (f, peer, delivered) = await Transports[transport].Start();
            await using var disposePeer = peer;
            await using var disposeFixture = f;
            var args = (JsonObject)variant.Args.DeepClone();
            if (file)
                args["filePath"] = await FileAsync(f);
            await f.Manager.Authorization.InstallAsync(Encoding.UTF8.GetBytes(OperationEffectConformance.Policy), default);
            var files = new WorkspaceTools(f.Manager.IdentityWorkspace(f.Owner).ToolDirectory);
            var found = await Run(
                variant with { Args = args },
                f.Manager,
                f.Owner,
                (name, values) => f.Manager.AssessToolAsync(f.Owner, f.Registry.Resolve(name, values), files, default),
                async (name, values) => await f.ToolAsync(name, values),
                [],
                deliveries: () => delivered().DistinctBy(effect => effect.Resources.ToJsonString()).ToList()
            );
            problems.AddRange(found.Select(problem => "[" + variant.Name + "] " + problem));
        }
        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }
}
