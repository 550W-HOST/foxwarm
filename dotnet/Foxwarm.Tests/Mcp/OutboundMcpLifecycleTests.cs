using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class OutboundMcpLifecycleTests
{
    private static JsonObject Args(string tag) => new() { ["tag"] = tag };
    private static string Id(JsonNode? value) => value!["id"]!.GetValue<string>();
    private static JsonObject Search() => new() { ["sources"] = new JsonArray("mcp"), ["server"] = "peer" };

    [Fact]
    public async Task Official_stdio_reuses_process_for_discovery_calls_native_Monty_and_credential_only_changes()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        var root = Path.Combine(f.Temp.Path, "stdio");
        await f.Mcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["transport"] = "stdio", ["command"] = "node", ["args"] = new JsonArray(OutboundSdkPeer.Script, "stdio", root), ["stderr"] = "pipe" }, default);
        var tools = f.Tools(f.First);
        var discovered = await tools.ExecuteAsync(new JsonObject { ["name"] = "search_tools", ["args"] = Search() }, default);
        Assert.Contains("probe", discovered!["output"]!.GetValue<string>());
        Assert.Equal("stdio", Id(await f.CallAsync(f.First, "probe", Args("first"))));
        Assert.Equal("stdio", Id(await f.CallAsync(f.Second, "probe", Args("second"))));
        var script = await f.ScriptAsync("return call_tool('mcp:peer/probe', {'tag': 'native'})");
        Assert.Equal("completed", script!["status"]!.GetValue<string>());
        Assert.Equal("stdio", Id(script["result"]));
        await f.Mcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["token"] = Guid.NewGuid().ToString("N"), ["headers"] = new JsonObject { ["X-Qualification"] = Guid.NewGuid().ToString("N") }, ["timeoutSeconds"] = 1 }, default);
        using var cancel = new CancellationTokenSource();
        var stopped = f.CallAsync(f.First, "hold", Args("stopped"), cancel.Token);
        await WaitFileAsync(root, "effect", "stopped");
        cancel.Cancel();
        var response = await stopped.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal("tool_call_cancelled", response!["error"]!["type"]!.GetValue<string>());
        Assert.Equal("stdio", Id(await f.CallAsync(f.First, "probe", Args("after-stop"))));
        var timed = await f.CallAsync(f.First, "hold", Args("timeout"));
        Assert.Contains("timed out", timed!["error"]!["message"]!.GetValue<string>());
        await WaitFileAsync(root, "cancelled", "timeout");
        Assert.Equal("stdio", Id(await f.CallAsync(f.First, "probe", Args("after-timeout"))));
        var events = await FileEventsAsync(root);
        Assert.Single(events, row => row["kind"]!.GetValue<string>() == "process");
        Assert.Single(events, row => row["kind"]!.GetValue<string>() == "effect" && row["tag"]?.GetValue<string>() == "stopped");
        Assert.Single(events, row => row["kind"]!.GetValue<string>() == "effect" && row["tag"]?.GetValue<string>() == "timeout");
    }

    [Fact]
    public async Task Stateful_HTTP_reuses_trusted_owner_across_discovery_calls_and_native_Monty_but_isolates_other_Sessions()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp");
        var search = await f.Tools(f.First).ExecuteAsync(new JsonObject { ["name"] = "search_tools", ["args"] = Search() }, default);
        Assert.Contains("probe", search!["output"]!.GetValue<string>());
        var first = Id(await f.CallAsync(f.First, "probe", Args("first")));
        var again = Id(await f.CallAsync(f.First, "probe", Args("again")));
        var script = await f.ScriptAsync("search_tools = call_tool('search_tools', {'sources': ['mcp'], 'server': 'peer'})\nreturn {'search': search_tools, 'call': call_tool('mcp:peer/probe', {'tag': 'native'})}");
        Assert.Equal("completed", script!["status"]!.GetValue<string>());
        Assert.Equal(first, Id(script["result"]!["call"]));
        Assert.Equal(first, again);
        var second = Id(await f.CallAsync(f.Second, "probe", Args("second")));
        Assert.NotEqual(first, second);
        var events = await peer.EventsAsync();
        Assert.Equal(2, events.Count(row => row["kind"]!.GetValue<string>() == "initialize"));
        Assert.All(events.Where(row => row["kind"]!.GetValue<string>() == "initialize"), row => Assert.StartsWith("2025-", row["protocol"]!.GetValue<string>()));
        Assert.Contains(events, row => row["method"]?.GetValue<string>() == "server/discover");
        Assert.All(events.Where(row => row["kind"]!.GetValue<string>() == "list"), row => Assert.Equal(first, row["id"]!.GetValue<string>()));
        var failed = await f.CallAsync(f.First, "fail", Args("non-replay"));
        Assert.NotNull(failed!["error"]);
        Assert.Single((await peer.EventsAsync()), row => row["kind"]!.GetValue<string>() == "effect" && row["tag"]?.GetValue<string>() == "non-replay");
        Assert.Equal(first, Id(await f.CallAsync(f.First, "probe", Args("after-error"))));
        await f.DisposeAsync();
        var deleted = await peer.WaitAsync("delete", count: 2);
        Assert.Equal(2, deleted.Select(row => row["id"]!.GetValue<string>()).Distinct().Count());
        Assert.Equal(2, deleted.Length); // SDK OwnsSession, not an additional custom DELETE.
    }

    [Fact]
    public async Task One_cancelled_HTTP_request_does_not_dispose_another_active_lease_then_idle_Stop_releases_its_binding()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp");
        var id = Id(await f.CallAsync(f.First, "probe"));
        using var cancel = new CancellationTokenSource();
        var cancelled = f.CallAsync(f.First, "hold", Args("one"), cancel.Token);
        await peer.WaitAsync("effect", "one");
        var surviving = f.CallAsync(f.First, "hold", Args("two"));
        await peer.WaitAsync("effect", "two");
        cancel.Cancel();
        Assert.Equal("tool_call_cancelled", (await cancelled)!["error"]!["type"]!.GetValue<string>());
        Assert.False(surviving.IsCompleted);
        Assert.DoesNotContain((await peer.EventsAsync()), row => row["kind"]!.GetValue<string>() == "delete");
        await peer.ReleaseAsync("two");
        Assert.Equal(id, Id(await surviving));
        Assert.Equal(id, Id(await f.CallAsync(f.First, "probe")));
        using var idleStop = new CancellationTokenSource();
        var single = f.CallAsync(f.First, "hold", Args("single"), idleStop.Token);
        await peer.WaitAsync("effect", "single");
        idleStop.Cancel();
        Assert.NotNull((await single)!["error"]);
        Assert.Single(await peer.WaitAsync("delete"));
        Assert.NotEqual(id, Id(await f.CallAsync(f.First, "probe")));
        foreach (var tag in new[] { "one", "two", "single" })
            Assert.Single((await peer.EventsAsync()), row => row["kind"]!.GetValue<string>() == "effect" && row["tag"]?.GetValue<string>() == tag);
    }

    [Fact]
    public async Task Actual_configuration_identity_move_and_deletion_invalidate_only_their_HTTP_lifetimes()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp");
        var first = Id(await f.CallAsync(f.First, "probe"));
        var second = Id(await f.CallAsync(f.Second, "probe"));
        await f.Manager.MoveIdentityAsync(f.First, new JsonObject { ["newSessionId"] = "moved" });
        var deleted = await peer.WaitAsync("delete");
        Assert.Equal(first, deleted.Single()["id"]!.GetValue<string>());
        Assert.Equal(second, Id(await f.CallAsync(f.Second, "probe")));
        var moved = Id(await f.CallAsync(f.First, "probe"));
        Assert.NotEqual(first, moved);
        var outcome = await f.Manager.DeleteAsync(f.Second.Id, source: f.First);
        Assert.Equal("deleted", outcome["status"]!.GetValue<string>());
        Assert.Contains(await peer.WaitAsync("delete", count: 2), row => row["id"]!.GetValue<string>() == second);
        Assert.NotNull((await f.CallAsync(f.Second, "probe"))!["error"]);
        Assert.Equal(moved, Id(await f.CallAsync(f.First, "probe")));
        await f.Mcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["timeoutSeconds"] = 2 }, default);
        await peer.WaitAsync("delete", count: 3);
        var changed = Id(await f.CallAsync(f.First, "probe"));
        Assert.NotEqual(moved, changed);
        await f.Mcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["enable"] = false }, default);
        await peer.WaitAsync("delete", count: 4);
        Assert.NotNull((await f.CallAsync(f.First, "probe"))!["error"]);
        await f.Mcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["enable"] = true }, default);
        Assert.NotEqual(changed, Id(await f.CallAsync(f.First, "probe")));
    }

    [Fact]
    public async Task Configuration_invalidation_during_real_initialize_does_not_publish_a_late_old_binding()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/init-fail");
        var initializing = f.CallAsync(f.First, "probe");
        await peer.WaitAsync("blocked-initialize");
        await f.ConfigureAsync(peer.Url + "/mcp");
        await peer.ReleaseAsync("initialize");
        Assert.NotNull((await initializing.WaitAsync(TimeSpan.FromSeconds(10)))!["error"]);
        var current = Id(await f.CallAsync(f.First, "probe"));
        Assert.Equal(current, Id(await f.CallAsync(f.First, "probe")));
        Assert.Single((await peer.EventsAsync()), row => row["kind"]!.GetValue<string>() == "initialize");
    }

    [Theory]
    [InlineData("sse", "/sse", 0)]
    [InlineData("auto", "/auto", 1)]
    public async Task Official_SSE_and_auto_initialization_cleanup_reuse_without_replaying_effects(string transport, string path, int failedProbes)
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + path, transport);
        var first = Id(await f.CallAsync(f.First, "probe"));
        Assert.Equal(first, Id(await f.CallAsync(f.First, "probe")));
        Assert.NotNull((await f.CallAsync(f.First, "fail", Args("sse-effect")))!["error"]);
        var events = await peer.EventsAsync();
        Assert.Single(events, row => row["kind"]!.GetValue<string>() == "sse-open");
        Assert.Equal(failedProbes, events.Count(row => row["kind"]!.GetValue<string>() == "failed-http-probe"));
        Assert.Single(events, row => row["kind"]!.GetValue<string>() == "effect");
        await f.Mcp.ConfigureAsync(new JsonObject { ["name"] = "peer", ["enable"] = false }, default);
        await peer.WaitAsync("closed");
        Assert.DoesNotContain((await peer.EventsAsync()), row => row["kind"]!.GetValue<string>() == "delete");
    }

    [Fact]
    public async Task Host_shutdown_cancels_inflight_requests_drains_official_bindings_and_fences_new_effects()
    {
        using var temp = new TempDirectory();
        await using var peer = await OutboundSdkPeer.StartAsync(temp.Path);
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.ConfigureAsync(peer.Url + "/mcp");
        var call = f.CallAsync(f.First, "hold", Args("shutdown"));
        await peer.WaitAsync("effect", "shutdown");
        f.Manager.BeginShutdown();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => call.WaitAsync(TimeSpan.FromSeconds(10)));
        await f.Mcp.DrainAsync();
        Assert.NotNull((await f.CallAsync(f.First, "probe"))!["error"]);
        await f.DisposeAsync();
        Assert.Single(await peer.WaitAsync("delete"));
        Assert.Single((await peer.EventsAsync()), row => row["kind"]!.GetValue<string>() == "call");
    }

    private static async Task<JsonObject[]> FileEventsAsync(string root) =>
        (await File.ReadAllLinesAsync(Path.Combine(root, "events.ndjson"))).Where(line => line.Length > 0).Select(line => JsonNode.Parse(line)!.AsObject()).ToArray();

    private static async Task WaitFileAsync(string root, string kind, string tag)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!(await FileEventsAsync(root)).Any(row => row["kind"]?.GetValue<string>() == kind && row["tag"]?.GetValue<string>() == tag))
            await Task.Delay(20, deadline.Token);
    }
}
