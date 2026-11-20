using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    private static async Task RegisterPeer(Fixture f, string id, params string[] tools)
    {
        var credential = f.Manager.Nodes.Registry.Create(id);
        var socket = new ClientWebSocket();
        f.Sockets.Add(socket);
        await socket.ConnectAsync(
            new Uri(
                f.App.Urls.Single().Replace("http", "ws")
                    + "/node_ws?id="
                    + id
                    + "&auth="
                    + credential["authToken"]!.GetValue<string>()
            ),
            default
        );
        await Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "node_register",
                ["nodeType"] = "cli-node",
                ["nodeProtocol"] = new JsonObject { ["min"] = 1, ["max"] = 3 },
                ["capabilities"] = new JsonObject
                {
                    ["tools"] = new JsonArray(
                        tools.Select(name => (JsonNode?)new JsonObject { ["name"] = name }).ToArray()
                    ),
                },
            }
        );
        Assert.Equal("registered", (await Fixture.Read(socket))["type"]!.GetValue<string>());
    }

    // Node select lists the default-cwd check exactly when the handler makes it: a remote
    // Node that is not Provider-backed and advertises get_default_cwd.
    [Fact]
    public async Task Explain_lists_the_default_cwd_check_only_for_a_Node_that_advertises_it()
    {
        await using var f = new Fixture();
        await f.Start();
        await RegisterPeer(f, "cwd-peer", "read", "get_default_cwd");
        await RegisterPeer(f, "plain-peer", "read");
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\ndefaultAction: allow\nrules:\n- id: no-default-cwd\n  tool: {source: node, name: get_default_cwd}\n  action: deny\n"
            ),
            default
        );
        Assert.True(f.Manager.DefaultCwdProbe("cwd-peer"));
        Assert.False(f.Manager.DefaultCwdProbe("plain-peer"));
        Assert.False(f.Manager.DefaultCwdProbe("master"));
        var result = await f.Manager.ExplainToolAuthorizationAsync(
            f.Owner,
            new WorkspaceTools(f.Work),
            new JsonObject
            {
                ["compact"] = true,
                ["probes"] = new JsonArray(
                    new JsonObject { ["sessionId"] = f.Owner.Id, ["command"] = "node select cwd-peer" },
                    new JsonObject { ["sessionId"] = f.Owner.Id, ["command"] = "node select plain-peer" }
                ),
            },
            default
        );
        var rows = result["probes"]!.AsArray();
        Assert.True(
            JsonNode.DeepEquals(
                JsonNode.Parse("""{"id":"default-cwd","decision":"deny","rule":"no-default-cwd"}"""),
                rows[0]!["obligation"]
            ),
            rows[0]!.ToJsonString()
        );
        Assert.Equal("allow", rows[1]!["decision"]!.GetValue<string>());
        Assert.Null(rows[1]!["obligation"]);
    }
}
