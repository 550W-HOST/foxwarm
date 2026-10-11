using System.Net;
using System.Net.WebSockets;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ShellHttpTests
{
    private static void ObserveRegistryWrite(NodeConnectionHub hub, Action<AtomicJsonWriteStage>? hook)
    {
        var file = typeof(ApprovedNodeRegistry).GetField("file", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(hub.Registry)!;
        typeof(LinuxAtomicJsonFile).GetField("stageHook", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(file, hook);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_http_registration_publication_serializes_with_credential_revocation(bool rename)
    {
        await using var fixture = new Fixture(); await fixture.Start(register: false);
        using var touched = new ManualResetEventSlim(); using var release = new ManualResetEventSlim();
        var gate = typeof(NodeConnectionHub).GetField("gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(fixture.Manager.Nodes)!;
        ObserveRegistryWrite(fixture.Manager.Nodes, stage =>
        {
            if (stage != AtomicJsonWriteStage.AfterDirectorySync) return;
            touched.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("HTTP publication barrier timed out.");
        });
        try
        {
            var register = fixture.Request("register", Encoding.UTF8.GetBytes("/startup"));
            Assert.True(touched.Wait(TimeSpan.FromSeconds(5)));
            var acquired = Monitor.TryEnter(gate); if (acquired) Monitor.Exit(gate); Assert.False(acquired);
            var revoke = Task.Run(() => { if (rename) fixture.Manager.Nodes.Rename("shell", "renamed"); else fixture.Manager.Nodes.Remove("shell"); });
            release.Set();
            using var registered = await register; await revoke.WaitAsync(TimeSpan.FromSeconds(5));
            ObserveRegistryWrite(fixture.Manager.Nodes, null);
            Assert.Equal(HttpStatusCode.NoContent, registered.StatusCode);
            Assert.False(fixture.Manager.Nodes.Online("shell"));
            Assert.False(fixture.Manager.Nodes.Registry.Authenticate("shell", fixture.Auth));
            foreach (var route in new[] { "register", "poll", "report" })
            { using var denied = await fixture.Request(route, Encoding.UTF8.GetBytes("/startup")); Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode); }
            if (rename) Assert.True(fixture.Manager.Nodes.Registry.Authenticate("renamed", fixture.Auth));
            else
            {
                var newCredential = fixture.Manager.Nodes.Registry.Create("shell");
                using var stale = await fixture.Request("register", Encoding.UTF8.GetBytes("/startup")); Assert.Equal(HttpStatusCode.Unauthorized, stale.StatusCode);
                fixture.Credential = newCredential; await fixture.Register(); Assert.True(fixture.Manager.Nodes.Online("shell"));
            }
        }
        finally { release.Set(); ObserveRegistryWrite(fixture.Manager.Nodes, null); }
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Http_runtime_revocation_preserves_the_existing_precommit_and_committed_failure_boundary(bool rename, bool committed)
    {
        await using var fixture = new Fixture(); await fixture.Start();
        ObserveRegistryWrite(fixture.Manager.Nodes, stage =>
        {
            if (stage == (committed ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename)) throw new IOException("Injected registry durability failure.");
        });
        try
        {
            Action revoke = () => { if (rename) fixture.Manager.Nodes.Rename("shell", "renamed"); else fixture.Manager.Nodes.Remove("shell"); };
            if (committed) Assert.Throws<AuthorityCommittedException>(revoke); else Assert.Throws<IOException>(revoke);
            Assert.Equal(!committed, fixture.Manager.Nodes.Online("shell"));
            Assert.Equal(!committed, fixture.Manager.Nodes.Registry.Authenticate("shell", fixture.Auth));
            var reloaded = new ApprovedNodeRegistry(fixture.Data);
            Assert.Equal(!committed, reloaded.Authenticate("shell", fixture.Auth));
            Assert.Equal(rename && committed, reloaded.Authenticate("renamed", fixture.Auth));
        }
        finally { ObserveRegistryWrite(fixture.Manager.Nodes, null); }
    }

    [Fact]
    public async Task Stale_http_disconnect_and_real_ws_close_cannot_retire_successor_transports()
    {
        await using var fixture = new Fixture(); await fixture.Start();
        var map = (System.Collections.IDictionary)typeof(NodeConnectionHub).GetField("nodes", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(fixture.Manager.Nodes)!;
        var first = map["shell"]!;
        var http = first.GetType().GetField("Http", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(first)!;
        var disconnect = http.GetType().GetMethod("Disconnect", BindingFlags.Instance | BindingFlags.NonPublic)!;
        await fixture.Register();
        var second = map["shell"]!; Assert.NotSame(first, second);
        disconnect.Invoke(http, null); Assert.Same(second, map["shell"]); Assert.True(fixture.Manager.Nodes.Online("shell"));
        using var ws = new ClientWebSocket();
        await ws.ConnectAsync(new Uri(fixture.App.Urls.Single().Replace("http", "ws") + "/node_ws?id=shell&auth=" + fixture.Auth), default);
        await ws.SendAsync(Encoding.UTF8.GetBytes(new JsonObject
        {
            ["type"] = "node_register", ["nodeType"] = "qualification-peer",
            ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
            ["capabilities"] = new JsonObject { ["tools"] = new JsonArray(new JsonObject { ["name"] = "probe" }) },
        }.ToJsonString()), WebSocketMessageType.Text, true, default);
        var buffer = new byte[65536]; using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var read = await ws.ReceiveAsync(buffer, deadline.Token); Assert.Equal("registered", JsonNode.Parse(buffer.AsSpan(0, read.Count))!["type"]!.GetValue<string>());
        var socketConnection = map["shell"]!; Assert.NotSame(second, socketConnection);
        disconnect.Invoke(http, null); Assert.Same(socketConnection, map["shell"]);
        // A replacement HTTP registration closes the real predecessor socket; its late finally stays fenced.
        await fixture.Register();
        var successor = map["shell"]!; Assert.NotSame(socketConnection, successor);
        read = await ws.ReceiveAsync(buffer, deadline.Token); Assert.Equal(WebSocketMessageType.Close, read.MessageType);
        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "qualification end", deadline.Token);
        Assert.True(fixture.Manager.Nodes.Online("shell")); Assert.Same(successor, map["shell"]);
        var execution = fixture.Exec(); var task = await fixture.Poll();
        using var report = await fixture.Report(task.Task, true); Assert.Equal(HttpStatusCode.NoContent, report.StatusCode); await execution;
    }

    [Fact]
    public async Task Native_data_preserves_exact_empty_short_and_overlapping_samples_but_not_invalid_utf8_or_large_output()
    {
        await using var fixture = new Fixture(); await fixture.Start();
        foreach (var sample in new[] { Array.Empty<byte>(), Encoding.UTF8.GetBytes("short without newline"), Encoding.UTF8.GetBytes(new string('x', 6000)), new byte[] { 0xc3 } })
        {
            var execution = fixture.Exec(programmatic: true); var task = await fixture.Poll();
            using var response = await fixture.Report(task.Task, true, sample); Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
            var result = (await execution)!;
            if (sample.SequenceEqual(new byte[] { 0xc3 })) { Assert.Null(result["content"]); Assert.True(result["truncated"]!.GetValue<bool>()); }
            else { Assert.Equal(Encoding.UTF8.GetString(sample), result["content"]!.GetValue<string>()); Assert.False(result["truncated"]!.GetValue<bool>()); }
        }
        var largeExecution = fixture.Exec(programmatic: true); var largeTask = await fixture.Poll();
        using var largeResponse = await fixture.Report(largeTask.Task, true, Encoding.UTF8.GetBytes(new string('x', 8192)), total: "9000"); Assert.Equal(HttpStatusCode.NoContent, largeResponse.StatusCode);
        var largeResult = (await largeExecution)!; Assert.Null(largeResult["content"]); Assert.True(largeResult["truncated"]!.GetValue<bool>()); Assert.Equal(9000, largeResult["sizeBytes"]!.GetValue<long>());
    }
}
