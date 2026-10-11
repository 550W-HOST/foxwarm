using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class NodeFileTransferTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal WebApplication App = null!;
        internal readonly List<ClientWebSocket> Sockets = [];
        internal string Work => Path.Combine(Temp.Path, "work");
        internal string Data => Path.Combine(Temp.Path, "data");

        internal async Task Start()
        {
            var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);
            Manager = new(Data, Work, options, HostModels.ForTest(options));
            await Manager.LoadAsync();
            Owner = await Manager.CreateNamedAsync("main", "files", null, null);
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            App = builder.Build();
            App.UseWebSockets();
            App.Map("/node_ws", Manager.Nodes.HandleAsync);
            await App.StartAsync();
        }

        internal async Task<ClientWebSocket> Connect(string id, JsonObject? credential = null)
        {
            credential ??= Manager.Nodes.Registry.Create(id);
            var socket = new ClientWebSocket();
            Sockets.Add(socket);
            await socket.ConnectAsync(new Uri(App.Urls.Single().Replace("http", "ws") + "/node_ws?id=" + id + "&auth=" + credential["authToken"]!.GetValue<string>()), default);
            await Send(socket, new JsonObject
            {
                ["type"] = "node_register", ["nodeType"] = "file-peer",
                ["capabilities"] = new JsonObject { ["tools"] = new JsonArray(new JsonObject { ["name"] = "read" }, new JsonObject { ["name"] = "write" }) },
                ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
            });
            Assert.Equal("registered", (await Read(socket))["type"]!.GetValue<string>());
            return socket;
        }

        internal static async Task Send(ClientWebSocket socket, JsonObject value) =>
            await socket.SendAsync(Encoding.UTF8.GetBytes(value.ToJsonString()), WebSocketMessageType.Text, true, default);

        internal static async Task<JsonObject> Read(ClientWebSocket socket)
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            using var stream = new MemoryStream();
            var buffer = new byte[65536];
            WebSocketReceiveResult read;
            do { read = await socket.ReceiveAsync(buffer, limit.Token); stream.Write(buffer, 0, read.Count); } while (!read.EndOfMessage);
            return JsonNode.Parse(stream.ToArray())!.AsObject();
        }

        internal static JsonObject Reply(JsonObject request, byte[] bytes, bool write = false) => new()
        {
            ["type"] = write ? "file_write_response" : "file_read_response",
            ["transferId"] = request["transferId"]!.DeepClone(),
            [write ? "result" : "file"] = new JsonObject
            {
                ["filePath"] = request["filePath"]!.DeepClone(), ["name"] = "binary.bin",
                ["sizeBytes"] = bytes.Length, ["sha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)),
                ["dataBase64"] = Convert.ToBase64String(bytes), ["overwritten"] = false,
            },
        };

        public async ValueTask DisposeAsync()
        {
            foreach (var socket in Sockets) { socket.Abort(); socket.Dispose(); }
            if (App is not null) { await App.StopAsync(); await App.DisposeAsync(); }
            if (Manager is not null) await Manager.DisposeAsync();
            Temp.Dispose();
        }
    }

    [Fact]
    public async Task Whole_binary_transfer_correlates_exact_connection_type_and_integrity()
    {
        await using var f = new Fixture(); await f.Start();
        var one = await f.Connect("one"); var two = await f.Connect("two");
        var pending = f.Manager.Nodes.ReadFileAsync("one", "C:\\remote\\binary.bin", f.Owner, false, default);
        var request = await Fixture.Read(one);
        Assert.Equal(f.Owner.Id, request["sessionId"]!.GetValue<string>());
        Assert.Equal(f.Owner.Agent, request["agentName"]!.GetValue<string>());
        Assert.Equal("C:\\remote\\binary.bin", request["filePath"]!.GetValue<string>());
        Assert.False(request["restrictToAgentDir"]!.GetValue<bool>());
        byte[] bytes = [0, 255, 1, 128];
        await Fixture.Send(two, Fixture.Reply(request, bytes));
        await Fixture.Send(one, Fixture.Reply(request, bytes, true));
        await Fixture.Send(one, new JsonObject { ["type"] = "ping" });
        Assert.Equal("pong", (await Fixture.Read(one))["type"]!.GetValue<string>());
        Assert.False(pending.IsCompleted);
        await Fixture.Send(one, Fixture.Reply(request, bytes));
        Assert.Equal(bytes, (await pending).Bytes);
        pending = f.Manager.Nodes.ReadFileAsync("one", "x", f.Owner, false, default);
        request = await Fixture.Read(one);
        var corrupt = Fixture.Reply(request, bytes); corrupt["file"]!["sha256"] = new string('0', 64);
        await Fixture.Send(one, corrupt);
        await Assert.ThrowsAsync<InvalidDataException>(() => pending);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Canceled_or_disconnected_write_is_not_replayed_and_late_reply_cannot_settle_next_transfer(bool disconnect)
    {
        await using var f = new Fixture(); await f.Start();
        var one = await f.Connect("one");
        using var cancel = new CancellationTokenSource();
        byte[] bytes = [1, 2, 3];
        var pending = f.Manager.Nodes.WriteFileAsync("one", "nested/once.bin", bytes, false, f.Owner, false, cancel.Token);
        var request = await Fixture.Read(one);
        Assert.False(request["overwrite"]!.GetValue<bool>());
        Assert.Equal(bytes, Convert.FromBase64String(request["dataBase64"]!.GetValue<string>()));
        if (disconnect) one.Abort(); else cancel.Cancel();
        var error = await Assert.ThrowsAsync<IOException>(() => pending);
        Assert.Contains("not retried", error.Message);
        if (disconnect) return;
        await Fixture.Send(one, Fixture.Reply(request, bytes, true));
        var next = f.Manager.Nodes.ReadFileAsync("one", "next.bin", f.Owner, false, default);
        var nextRequest = await Fixture.Read(one);
        Assert.Equal("file_read_request", nextRequest["type"]!.GetValue<string>());
        Assert.NotEqual(request["transferId"]!.ToString(), nextRequest["transferId"]!.ToString());
        await Fixture.Send(one, Fixture.Reply(request, bytes, true));
        await Fixture.Send(one, Fixture.Reply(nextRequest, bytes));
        Assert.Equal(bytes, (await next).Bytes);
    }

    [Fact]
    public async Task Transfer_rejects_oversized_write_before_dispatch_and_source_budget_before_decode()
    {
        await using var f = new Fixture(); await f.Start();
        var one = await f.Connect("one");
        await Assert.ThrowsAsync<InvalidDataException>(() => f.Manager.Nodes.WriteFileAsync("one", "large", new byte[NodeConnectionHub.FileLimit + 1], false, f.Owner, false, default));
        var pending = f.Manager.Nodes.ReadFileAsync("one", "source.py", f.Owner, false, default, _ => throw new InvalidDataException("source budget"));
        var request = await Fixture.Read(one);
        Assert.Equal("file_read_request", request["type"]!.ToString());
        await Fixture.Send(one, Fixture.Reply(request, Encoding.UTF8.GetBytes("return 42")));
        Assert.Equal("source budget", (await Assert.ThrowsAsync<InvalidDataException>(() => pending)).Message);
    }

    [Theory]
    [InlineData("sourceNode", "one")]
    [InlineData("targetNode", "two")]
    public async Task Copy_checks_both_endpoint_permissions_before_reading(string endpoint, string deniedNode)
    {
        await using var f = new Fixture(); await f.Start();
        var one = await f.Connect("one"); await f.Connect("two");
        await File.WriteAllTextAsync(Path.Combine(f.Data, "state", "tool-authorization.yaml"), $"version: 1\nrules:\n- id: endpoint\n  action: deny\n  match:\n    tool: {{source: builtin, name: copy_between_nodes}}\n    args: {{{endpoint}: {deniedNode}}}\n");
        f.Manager.Authorization.Invalidate();
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => f.Manager.CopyBetweenNodesAsync(f.Owner, new JsonObject { ["sourceNode"] = "one", ["sourcePath"] = "binary", ["targetNode"] = "two", ["targetPath"] = "copy" }, default));
        await Fixture.Send(one, new JsonObject { ["type"] = "ping" });
        Assert.Equal("pong", (await Fixture.Read(one))["type"]!.ToString());
        Assert.False(File.Exists(Path.Combine(f.Work, "copy")));
    }

    [Fact]
    public async Task Master_copy_ignores_session_cwd_and_preserves_no_overwrite_and_binary_bytes()
    {
        await using var f = new Fixture(); await f.Start();
        var project = Path.Combine(f.Temp.Path, "project"); Directory.CreateDirectory(project);
        await f.Owner.Entry.SaveLane.CommitCwdAsync(project);
        byte[] bytes = [0, 1, 255]; await File.WriteAllBytesAsync(Path.Combine(f.Work, "binary"), bytes);
        var args = new JsonObject { ["sourceNode"] = "master", ["sourcePath"] = "binary", ["targetNode"] = "master", ["targetPath"] = "nested/copy" };
        await f.Manager.CopyBetweenNodesAsync(f.Owner, args, default);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(f.Work, "nested/copy")));
        Assert.False(File.Exists(Path.Combine(project, "nested/copy")));
        await Assert.ThrowsAsync<IOException>(() => f.Manager.CopyBetweenNodesAsync(f.Owner, args, default));
        Assert.Equal(bytes, await File.ReadAllBytesAsync(Path.Combine(f.Work, "nested/copy")));
    }
}
