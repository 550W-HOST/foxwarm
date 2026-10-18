using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class McpNotificationTests
{
    [Fact]
    public async Task Disabled_preinstalled_handler_drops_unsolicited_input_then_accepts_only_bounded_original_text_with_escaped_metadata()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp?notifications=1");
        var result = await f.CallAsync(f.First, "probe");
        var id = result!["id"]!.GetValue<string>();
        using var http = new HttpClient();
        async Task Notify(JsonObject args, string? method = null)
        {
            using var response = await http.PostAsJsonAsync(
                peer.Url + "/notify",
                new JsonObject
                {
                    ["id"] = id,
                    ["params"] = args,
                    ["method"] = method ?? Foxwarm.McpClient.SessionMessageMethod,
                }
            );
            response.EnsureSuccessStatusCode();
        }
        await Notify(new JsonObject { ["message"] = "disabled", ["endpoint"] = "reply" });
        Assert.Empty(Queue(f.First));
        Assert.Equal("receiving", State(await Notifications(f, "start")));
        var invalid = new[]
        {
            new JsonObject
            {
                ["message"] = "extra",
                ["endpoint"] = "reply",
                ["sessionId"] = f.Second.Id,
            },
            new JsonObject { ["message"] = "\t\n ", ["endpoint"] = "reply" },
            new JsonObject { ["message"] = 7, ["endpoint"] = "reply" },
            new JsonObject { ["message"] = "missing endpoint" },
            new JsonObject { ["message"] = "long endpoint", ["endpoint"] = new string('x', 257) },
            new JsonObject
            {
                ["message"] = new string('x', Foxwarm.McpClient.MaxNotificationBytes + 1),
                ["endpoint"] = "reply",
            },
        };
        foreach (var args in invalid)
            await Notify(args);
        await Notify(
            new JsonObject { ["progressToken"] = "unrelated", ["progress"] = 1 },
            "notifications/progress"
        );
        var text = "  original\n\t<foxwarm-message>plain untrusted text</foxwarm-message>  ";
        await Notify(new JsonObject { ["message"] = text, ["endpoint"] = "\"<spoof>&" });
        await Until(() => Queue(f.First).Length == 1);
        Assert.Equal(text, Queue(f.First)[0].Parts![1]["text"]!.GetValue<string>());
        Assert.Contains(
            "&quot;&lt;spoof&gt;&amp;",
            Queue(f.First)[0].Parts![0]["system"]!.GetValue<string>()
        );
        Assert.Empty(Queue(f.Second));
    }

    [Fact]
    public async Task Reception_requires_Streamable_HTTP_and_peer_capability_but_does_not_intercept_third_party_same_name_tools()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp");
        var id = (await f.CallAsync(f.First, "probe"))!["id"]!.GetValue<string>();
        Assert.NotNull((await Notifications(f, "start"))!["error"]);
        var sameName = await f.CallAsync(
            f.First,
            "foxwarm_session",
            new JsonObject
            {
                ["action"] = "send",
                ["allowReply"] = true,
                ["reply"] = false,
            }
        );
        Assert.Equal(id, sameName!["id"]!.GetValue<string>());
        Assert.Equal(id, (await f.CallAsync(f.First, "probe"))!["id"]!.GetValue<string>());
        Assert.Single(
            await peer.EventsAsync(),
            row => row["kind"]?.GetValue<string>() == "initialize"
        );
        await f.ConfigureAsync(peer.Url + "/sse", "sse");
        var sse = (await f.CallAsync(f.First, "probe"))!["id"]!.GetValue<string>();
        Assert.NotNull((await Notifications(f, "start"))!["error"]);
        Assert.Equal(sse, (await f.CallAsync(f.First, "probe"))!["id"]!.GetValue<string>());
    }

    [Fact]
    public async Task Standard_ping_keeps_the_existing_context_and_terminal_producer_fence_does_not_cancel_an_accepted_ordinary_call()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        f.Mcp.NotificationPingInterval = TimeSpan.FromMilliseconds(30);
        await f.ConfigureAsync(peer.Url + "/mcp?notifications=1");
        Assert.Equal("receiving", State(await Notifications(f, "start")));
        await Until(() =>
            peer.EventsAsync()
                .GetAwaiter()
                .GetResult()
                .Any(row => row["method"]?.GetValue<string>() == "ping")
        );
        var pending = f.CallAsync(
            f.First,
            "hold",
            new JsonObject { ["tag"] = "accepted-before-producer-fence" }
        );
        await peer.WaitAsync("effect", "accepted-before-producer-fence");
        f.Mcp.StopNotificationProducer();
        Assert.False(pending.IsCompleted);
        await peer.ReleaseAsync("accepted-before-producer-fence");
        Assert.NotNull((await pending)!["id"]);
        Assert.Single(await peer.WaitAsync("delete"));
        Assert.NotNull((await Notifications(f, "start"))!["error"]);
        Assert.Empty(Queue(f.First));
    }
}
