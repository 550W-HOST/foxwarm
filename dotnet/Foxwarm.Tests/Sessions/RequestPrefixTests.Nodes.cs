using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed partial class RequestPrefixTests
{
    [Fact]
    public async Task External_Node_advertisements_and_denies_do_not_change_final_default_tools()
    {
        using var temp = new TempDirectory();
        var captures = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(
            4,
            async (_, stream, captured) =>
            {
                captures.Add(JsonNode.Parse(captured.Body)!.AsObject());
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Reply(null))
                );
            }
        );
        await using var manager = await CreateManager(temp.Path, peer.BaseUri);
        var owner = await manager.CreateNamedAsync("main", "external-prefix", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Turn(owner);

        var credential = manager.Nodes.Registry.Create("remote");
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.UseWebSockets();
        app.Map("/node_ws", manager.Nodes.HandleAsync);
        await app.StartAsync();
        using var socket = new ClientWebSocket();
        await socket.ConnectAsync(
            new Uri(
                app.Urls.Single().Replace("http", "ws")
                    + "/node_ws?id=remote&auth="
                    + credential["authToken"]!.GetValue<string>()
            ),
            default
        );
        // Deliberately different order, schemas, descriptions and capability set.
        var advertised = new JsonArray(
            new JsonObject { ["name"] = "remote_status", ["description"] = "remote-only" },
            new JsonObject { ["name"] = "browser_tabs", ["description"] = "hidden remote browser" },
            new JsonObject { ["name"] = "session", ["description"] = "colliding remote session" },
            new JsonObject
            {
                ["name"] = "exec",
                ["description"] = "remote execution declaration",
                ["parameters"] = new JsonObject
                {
                    ["type"] = "object",
                    ["properties"] = new JsonObject
                    {
                        ["remoteOnly"] = new JsonObject { ["type"] = "boolean" },
                    },
                },
            }
        );
        var registration = new JsonObject
        {
            ["type"] = "node_register",
            ["nodeType"] = "protocol-peer",
            ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
            ["capabilities"] = new JsonObject { ["tools"] = advertised.DeepClone() },
        };
        await socket.SendAsync(
            Encoding.UTF8.GetBytes(registration.ToJsonString()),
            WebSocketMessageType.Text,
            true,
            default
        );
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var bytes = new byte[65536];
        var received = await socket.ReceiveAsync(bytes, timeout.Token);
        Assert.Equal(
            "registered",
            JsonNode.Parse(bytes.AsSpan(0, received.Count))!["type"]!.GetValue<string>()
        );
        var remoteDefinitions = manager.NodeProviders.Definitions("remote");
        Assert.Equal(
            advertised.Select(tool => tool!["name"]!.GetValue<string>()),
            remoteDefinitions.Select(tool => tool!["name"]!.GetValue<string>())
        );
        Assert.Equal(
            "remote execution declaration",
            remoteDefinitions[^1]!["description"]!.GetValue<string>()
        );
        Assert.True(
            JsonNode.DeepEquals(advertised[^1]!["parameters"], remoteDefinitions[^1]!["parameters"])
        );
        await manager.SelectNodeAsync(owner, "remote");
        await Turn(owner);

        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "data", "state", "tool-authorization.yaml"),
            "version: 1\nrules:\n- action: deny\n  match:\n    tool: {source: node, name: exec}\n    targetNode: remote\n"
        );
        manager.Authorization.Invalidate();
        Assert.False(manager.ToolVisible(owner, "node", "exec", node: "remote"));
        await Turn(owner);
        manager.Nodes.Disconnect("remote", "Owned fixture disconnect");
        Assert.Empty(manager.NodeProviders.Definitions("remote"));
        await manager.RunBtwAsync(owner, "Disconnected external side question.");

        Assert.Equal(4, captures.Count);
        Assert.All(
            captures,
            request =>
            {
                Assert.Equal(
                    captures[0]["tools"]!.ToJsonString(),
                    request["tools"]!.ToJsonString()
                );
                Assert.Equal(Instructions(captures[0]), Instructions(request));
            }
        );
        var names = captures[0]["tools"]!
            .AsArray()
            .Select(tool => tool!["name"]!.GetValue<string>())
            .ToArray();
        Assert.Contains("exec", names);
        Assert.Contains("read", names);
        Assert.DoesNotContain("remote_status", names);
        Assert.DoesNotContain("browser_tabs", names);
        Assert.DoesNotContain("remoteOnly", captures[0]["tools"]!.ToJsonString());
        socket.Abort();
        await app.StopAsync();
    }
}
