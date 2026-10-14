using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class McpOAuthTests
{
    [Theory]
    [InlineData(true, true)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    public async Task Shared_initializer_protects_intermediate_credentials_independently_of_its_first_waiter(
        bool cancelFirst,
        bool failInitialization
    )
    {
        await using var peer = await McpOAuthPeer.StartAsync();
        await using var f = await OutboundMcpFixture.CreateAsync(PublicBase);
        await ConfigureAsync(f, peer);
        await peer.AuthorizeAsync(f.Mcp);
        await peer.SetAsync(new() { ["initializeError"] = failInitialization });
        await peer.GateAsync("initialize");
        using var stop = new CancellationTokenSource();
        var first = f.CallAsync(f.First, "state", token: stop.Token);
        await peer.WaitAsync("initialize401Entered");
        var surviving = f.CallAsync(f.First, "state");
        // Allow the second ordinary executor to join this owner's pending SDK initializer.
        await Task.Delay(100);
        if (cancelFirst)
        {
            stop.Cancel();
            Assert.Equal(
                "tool_call_cancelled",
                (await first.WaitAsync(TimeSpan.FromSeconds(5)))!["error"]![
                    "type"
                ]!.GetValue<string>()
            );
        }
        Assert.False(surviving.IsCompleted);
        await peer.ReleaseAsync("initialize401");
        await peer.WaitAsync("initializeResultEntered");
        var intermediate = (await peer.StateAsync())["initializeCredential"]!.GetValue<string>();
        var other = McpOAuthPeer.Value(await f.CallAsync(f.Second, "state"));
        await peer.SetAsync(new() { ["force401"] = 1 });
        Assert.Equal(
            other["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await f.CallAsync(f.Second, "state"))["context"]!.GetValue<int>()
        );
        var saved = JsonNode.Parse(
            await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "mcp-oauth.json"))
        )!;
        Assert.NotEqual(
            intermediate,
            saved["servers"]!["peer"]!["tokens"]!["access_token"]!.GetValue<string>()
        );
        await peer.ReleaseAsync("initializeResult");
        var response = await surviving.WaitAsync(TimeSpan.FromSeconds(5));
        if (failInitialization)
        {
            Assert.Equal("tool_error", response!["error"]!["type"]!.GetValue<string>());
            Assert.DoesNotContain(intermediate, response.ToJsonString());
            if (!cancelFirst)
            {
                var original = await first.WaitAsync(TimeSpan.FromSeconds(5));
                Assert.NotNull(original!["error"]);
                Assert.DoesNotContain(intermediate, original.ToJsonString());
            }
        }
        else
        {
            var survivor = McpOAuthPeer.Value(response);
            Assert.Equal(
                survivor["context"]!.GetValue<int>(),
                McpOAuthPeer.Value(await f.CallAsync(f.First, "state"))["context"]!.GetValue<int>()
            );
        }
        var state = await peer.StateAsync();
        Assert.Equal(2, Count(state, "refreshes"));
        Assert.Equal(failInitialization ? 2 : 4, Count(state, "effects"));
        Assert.Equal(failInitialization ? 1 : 2, Count(state, "contexts"));
        // Completed initialization does not retain a token history or censor later ordinary data.
        var ordinary = McpOAuthPeer.Value(await f.CallAsync(f.First, "state", Args(intermediate)));
        Assert.Equal(intermediate, ordinary["value"]!.GetValue<string>());
        Assert.Equal(
            other["context"]!.GetValue<int>(),
            McpOAuthPeer.Value(await f.CallAsync(f.Second, "state"))["context"]!.GetValue<int>()
        );
        Assert.Equal(failInitialization ? 4 : 6, Count(await peer.StateAsync(), "effects"));
    }
}
