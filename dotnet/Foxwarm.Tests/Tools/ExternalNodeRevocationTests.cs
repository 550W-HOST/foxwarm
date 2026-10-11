using System.Net.WebSockets;
using System.Reflection;
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

public sealed class ExternalNodeRevocationTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static JsonObject Registration =>
        new()
        {
            ["type"] = "node_register",
            ["nodeType"] = "test-peer",
            ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
            ["capabilities"] = new JsonObject
            {
                ["tools"] = new JsonArray(
                    new JsonObject
                    {
                        ["name"] = "probe",
                        ["parameters"] = new JsonObject
                        {
                            ["type"] = "object",
                            ["properties"] = new JsonObject(),
                        },
                    }
                ),
            },
        };

    // Instrument the existing persistence primitive, not credentials, connections or owners.
    private static void ObserveRegistryWrite(
        NodeConnectionHub hub,
        Action<AtomicJsonWriteStage>? hook
    )
    {
        var file = typeof(ApprovedNodeRegistry)
            .GetField("file", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(hub.Registry)!;
        typeof(LinuxAtomicJsonFile)
            .GetField("stageHook", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(file, hook);
    }

    private static async Task<WebApplication> StartAsync(NodeConnectionHub hub)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        var app = builder.Build();
        app.UseWebSockets();
        app.Map("/node_ws", hub.HandleAsync);
        await app.StartAsync();
        return app;
    }

    private static async Task ConnectAsync(
        ClientWebSocket socket,
        WebApplication app,
        JsonObject credential
    )
    {
        var uri =
            app.Urls.Single().Replace("http", "ws")
            + "/node_ws?id="
            + credential["nodeId"]!.GetValue<string>()
            + "&auth="
            + credential["authToken"]!.GetValue<string>();
        await socket.ConnectAsync(new Uri(uri), CancellationToken.None);
        await socket.SendAsync(
            Encoding.UTF8.GetBytes(Registration.ToJsonString()),
            WebSocketMessageType.Text,
            true,
            CancellationToken.None
        );
    }

    private static async Task<JsonNode?> ReceiveAsync(ClientWebSocket socket)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var buffer = new byte[65536];
        var result = await socket.ReceiveAsync(buffer, timeout.Token);
        return result.MessageType == WebSocketMessageType.Close
            ? null
            : JsonNode.Parse(Encoding.UTF8.GetString(buffer, 0, result.Count));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Credential_touch_and_publication_hold_the_revocation_lock_on_the_real_socket_path(
        bool rename
    )
    {
        using var temp = new TempDirectory();
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "proof", null, null);
        var hub = manager.Nodes;
        var credential = hub.Registry.Create("before");
        await using var app = await StartAsync(hub);
        using var socket = new ClientWebSocket();
        using var touched = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var gate = typeof(NodeConnectionHub)
            .GetField("gate", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(hub)!;
        ObserveRegistryWrite(
            hub,
            stage =>
            {
                if (stage != AtomicJsonWriteStage.AfterDirectorySync)
                    return;
                touched.Set();
                if (!release.Wait(TimeSpan.FromSeconds(10)))
                    throw new TimeoutException("Registration publication barrier timed out.");
            }
        );
        try
        {
            await ConnectAsync(socket, app, credential);
            Assert.True(
                touched.Wait(TimeSpan.FromSeconds(5)),
                "Real credential Touch must reach durable persistence."
            );
            var acquired = Monitor.TryEnter(gate);
            if (acquired)
                Monitor.Exit(gate);
            Assert.False(acquired); // The former split-lock ordering fails here.
            var revocation = Task.Run(() =>
            {
                if (rename)
                    hub.Rename("before", "after");
                else
                    hub.Remove("before");
            });
            release.Set();
            await revocation.WaitAsync(TimeSpan.FromSeconds(5));
            ObserveRegistryWrite(hub, null);
            Assert.False(
                hub.Registry.Authenticate("before", credential["authToken"]!.GetValue<string>())
            );
            Assert.False(hub.Online("before"));
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                manager.SelectNodeAsync(owner, "before")
            );
            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                hub.ExecuteAsync(
                    "before",
                    "probe",
                    new(),
                    owner.Id,
                    owner.Agent,
                    "before",
                    null,
                    false,
                    CancellationToken.None
                )
            );
            // Rename keeps credentials only under the new identity; normal registration/reconnect remains real.
            var replacement = rename
                ? new JsonObject
                {
                    ["nodeId"] = "after",
                    ["authToken"] = credential["authToken"]!.DeepClone(),
                }
                : hub.Registry.Create("before");
            using var successor = new ClientWebSocket();
            await ConnectAsync(successor, app, replacement);
            Assert.Equal(
                "registered",
                (await ReceiveAsync(successor))!["type"]!.GetValue<string>()
            );
            var id = replacement["nodeId"]!.GetValue<string>();
            Assert.True(hub.Online(id));
            Assert.Equal(
                id,
                (await manager.SelectNodeAsync(owner, id))["nodeId"]!.GetValue<string>()
            );
            successor.Abort();
        }
        finally
        {
            release.Set();
            ObserveRegistryWrite(hub, null);
            socket.Abort();
            await app.StopAsync();
        }
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task Revocation_invalidates_runtime_only_after_persistence_and_reports_committed_failures(
        bool rename,
        bool committed
    )
    {
        using var temp = new TempDirectory();
        using var hub = new NodeConnectionHub(temp.Path);
        var credential = hub.Registry.Create("before");
        await using var app = await StartAsync(hub);
        using var socket = new ClientWebSocket();
        await ConnectAsync(socket, app, credential);
        Assert.Equal("registered", (await ReceiveAsync(socket))!["type"]!.GetValue<string>());
        ObserveRegistryWrite(
            hub,
            stage =>
            {
                if (
                    stage
                    == (
                        committed
                            ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                            : AtomicJsonWriteStage.BeforeRename
                    )
                )
                    throw new IOException("Injected registry durability failure.");
            }
        );
        try
        {
            Action revoke = () =>
            {
                if (rename)
                    hub.Rename("before", "after");
                else
                    hub.Remove("before");
            };
            if (committed)
                Assert.Throws<AuthorityCommittedException>(revoke);
            else
                Assert.Throws<IOException>(revoke);
            Assert.Equal(!committed, hub.Online("before"));
            Assert.Equal(
                !committed,
                hub.Registry.Authenticate("before", credential["authToken"]!.GetValue<string>())
            );
            var persisted = new ApprovedNodeRegistry(temp.Path);
            Assert.Equal(
                !committed,
                persisted.Authenticate("before", credential["authToken"]!.GetValue<string>())
            );
            Assert.Equal(
                rename && committed,
                persisted.Authenticate("after", credential["authToken"]!.GetValue<string>())
            );
        }
        finally
        {
            ObserveRegistryWrite(hub, null);
            socket.Abort();
            await app.StopAsync();
        }
    }
}
