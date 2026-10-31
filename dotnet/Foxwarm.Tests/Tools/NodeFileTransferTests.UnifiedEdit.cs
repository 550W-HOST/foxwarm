using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class NodeFileTransferTests
{
    private static async Task<ClientWebSocket> ConnectEditPeer(
        Fixture f,
        bool unified,
        bool programmatic = true
    )
    {
        var credential = f.Manager.Nodes.Registry.Create("edit-peer");
        var socket = new ClientWebSocket();
        f.Sockets.Add(socket);
        await socket.ConnectAsync(
            new Uri(
                f.App.Urls.Single().Replace("http", "ws")
                    + "/node_ws?id=edit-peer&auth="
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
                        new JsonObject { ["name"] = "read" },
                        new JsonObject { ["name"] = "write" },
                        new JsonObject { ["name"] = "edit" },
                        new JsonObject { ["name"] = "apply_patch" }
                    ),
                    ["features"] = new JsonObject
                    {
                        ["unifiedEdit"] = unified,
                        ["programmaticToolData"] = programmatic,
                        ["externalToolOwner"] = 1,
                    },
                },
            }
        );
        Assert.Equal("registered", (await Fixture.Read(socket))["type"]!.GetValue<string>());
        await f.Manager.SelectNodeAsync(f.Owner, "edit-peer");
        await f.Owner.UpdateCwdAsync("/peer/project");
        return socket;
    }

    private static Task<JsonNode?> RemoteEdit(Fixture f, JsonObject args) =>
        f.Manager.NodeProviders.ExecuteAsync(
            "edit-peer",
            "edit",
            args,
            f.Owner.Id,
            f.Owner.Agent,
            "edit-peer",
            "/peer/project",
            false,
            default,
            f.Owner
        );

    private static Task RespondEdit(
        ClientWebSocket socket,
        JsonObject request,
        JsonNode? result = null
    ) =>
        Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "tool_call_response",
                ["callId"] = request["callId"]!.DeepClone(),
                ["result"] = result ?? new JsonObject { ["output"] = "File edited successfully" },
            }
        );

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Resident_unified_negotiation_routes_native_or_one_legacy_whole_file_edit(
        bool unified
    )
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectEditPeer(f, unified);
        var args = JsonNode
            .Parse(
                """{"filePath":"source.txt","edits":[{"oldText":"first","newText":"second"},{"oldText":"second","newText":"$$-$&-$`-$'\n"}]}"""
            )!
            .AsObject();
        var running = RemoteEdit(f, args);
        var request = await Fixture.Read(socket);
        if (!unified)
        {
            Assert.Equal("read", request["tool"]!.GetValue<string>());
            Assert.True(request["programmatic"]!.GetValue<bool>());
            Assert.Equal("/peer/project", request["sessionCwd"]!.GetValue<string>());
            const string original = "first second\r\n";
            await RespondEdit(
                socket,
                request,
                new JsonObject
                {
                    ["content"] = original,
                    ["truncated"] = false,
                    ["sizeBytes"] = Encoding.UTF8.GetByteCount(original),
                    ["selectedBytes"] = Encoding.UTF8.GetByteCount(original),
                }
            );
            request = await Fixture.Read(socket);
            Assert.Equal(original, request["args"]!["oldText"]!.GetValue<string>());
            Assert.Equal(
                "second $$$$-$$&-$$`-$$'\n\r\n",
                request["args"]!["newText"]!.GetValue<string>()
            );
            Assert.Null(request["args"]!["edits"]);
        }
        else
            Assert.True(JsonNode.DeepEquals(args, request["args"]));
        Assert.Equal("edit", request["tool"]!.GetValue<string>());
        Assert.Equal("source.txt", request["args"]!["filePath"]!.GetValue<string>());
        await RespondEdit(socket, request);
        Assert.NotNull(await running.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.DoesNotContain(
            f.Manager.NodeProviders.Definitions("edit-peer"),
            tool => tool?["name"]?.GetValue<string>() == "apply_patch"
        );
    }

    [Fact]
    public async Task Legacy_resident_single_and_patch_translate_without_read_and_keep_literal_replacement_data()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectEditPeer(f, false);
        var running = RemoteEdit(
            f,
            new JsonObject
            {
                ["filePath"] = "file",
                ["oldText"] = "old",
                ["newText"] = "$&\n$$",
                ["replaceAll"] = false,
            }
        );
        var request = await Fixture.Read(socket);
        Assert.Equal("edit", request["tool"]!.GetValue<string>());
        Assert.Equal("$$&\n$$$$", request["args"]!["newText"]!.GetValue<string>());
        Assert.Null(request["args"]!["replaceAll"]);
        await RespondEdit(socket, request);
        await running;
        const string patch = "*** Begin Patch\n*** Delete File: file\n*** End Patch";
        running = RemoteEdit(f, new JsonObject { ["apply_patch"] = patch });
        request = await Fixture.Read(socket);
        Assert.Equal("apply_patch", request["tool"]!.GetValue<string>());
        Assert.Equal(patch, request["args"]!["input"]!.GetValue<string>());
        await RespondEdit(socket, request);
        await running;
    }

    [Fact]
    public async Task Legacy_batch_requires_read_policy_and_read_approval_and_conflicts_never_dispatch_edit()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectEditPeer(f, false);
        var args = new JsonObject
        {
            ["filePath"] = "file",
            ["oldText"] = "a",
            ["newText"] = "b",
            ["replaceAll"] = true,
        };
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes(
                "version: 1\nrules: [{id: no-read, action: deny, match: {tool: {source: node, name: read}}}]\n"
            ),
            default
        );
        await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() => RemoteEdit(f, args));
        await f.Manager.Authorization.InstallAsync(
            Encoding.UTF8.GetBytes("version: 1\ndefaultAction: allow\n"),
            default
        );
        var running = RemoteEdit(f, args);
        var read = await Fixture.Read(socket);
        Assert.Equal("read", read["tool"]!.GetValue<string>());
        await Fixture.Send(
            socket,
            new JsonObject
            {
                ["type"] = "tool_call_error",
                ["callId"] = read["callId"]!.DeepClone(),
                ["error"] = "Read rejected by operator",
            }
        );
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => running);
        running = RemoteEdit(f, args);
        read = await Fixture.Read(socket);
        Assert.Equal("read", read["tool"]!.GetValue<string>());
        await RespondEdit(
            socket,
            read,
            new JsonObject
            {
                ["content"] = "missing",
                ["sizeBytes"] = 7,
                ["selectedBytes"] = 7,
                ["truncated"] = false,
            }
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => running);
        await Fixture.Send(socket, new JsonObject { ["type"] = "ping" });
        Assert.Equal("pong", (await Fixture.Read(socket))["type"]!.GetValue<string>());
    }

    [Fact]
    public async Task Old_resident_without_programmatic_content_uses_approved_read_then_existing_byte_transfer()
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectEditPeer(f, false, false);
        var running = RemoteEdit(
            f,
            new JsonObject
            {
                ["filePath"] = "file",
                ["oldText"] = "a",
                ["newText"] = "$&\n",
                ["replaceAll"] = true,
            }
        );
        var read = await Fixture.Read(socket);
        Assert.Equal("read", read["tool"]!.GetValue<string>());
        Assert.Null(read["programmatic"]);
        await RespondEdit(
            socket,
            read,
            new JsonObject { ["output"] = "a a\n---\nFile has 1 line." }
        );
        var transfer = await Fixture.Read(socket);
        Assert.Equal("file_read_request", transfer["type"]!.GetValue<string>());
        Assert.Equal("/peer/project/file", transfer["filePath"]!.GetValue<string>());
        await Fixture.Send(socket, Fixture.Reply(transfer, Encoding.UTF8.GetBytes("a a\r\n")));
        var edit = await Fixture.Read(socket);
        Assert.Equal("edit", edit["tool"]!.GetValue<string>());
        Assert.Equal("a a\r\n", edit["args"]!["oldText"]!.GetValue<string>());
        Assert.Equal("$$&\n $$&\n\r\n", edit["args"]!["newText"]!.GetValue<string>());
        await RespondEdit(socket, edit);
        await running;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task External_legacy_peers_keep_single_and_patch_edits_but_require_upgrade_for_new_forms(
        bool unified
    )
    {
        await using var f = new Fixture();
        await f.Start();
        var socket = await ConnectEditPeer(f, unified);
        var access = new Foxwarm.AccessConfiguration(InboundMcpFixture.App());
        var context = new Foxwarm.McpExternalContext(
            Foxwarm.McpExternalPrincipal.Authenticate(access, InboundMcpFixture.Alpha)!
        );
        Task<JsonNode?> Call(JsonObject args) =>
            f.Manager.Nodes.ExecuteExternalAsync(
                context,
                "edit-peer",
                "edit",
                args,
                "/peer/project",
                null,
                context.Require,
                default
            );
        var batch = JsonNode
            .Parse("""{"filePath":"file","edits":[{"oldText":"old","newText":"new"}]}""")!
            .AsObject();
        if (!unified)
        {
            await Assert.ThrowsAsync<Foxwarm.McpInboundSafeException>(() => Call(batch));
            await Assert.ThrowsAsync<Foxwarm.McpInboundSafeException>(() =>
                Call(
                    new JsonObject
                    {
                        ["filePath"] = "file",
                        ["oldText"] = "a",
                        ["newText"] = "b",
                        ["replaceAll"] = true,
                    }
                )
            );
            await Fixture.Send(socket, new JsonObject { ["type"] = "ping" });
            Assert.Equal("pong", (await Fixture.Read(socket))["type"]!.GetValue<string>());
        }
        else
        {
            var native = Call(batch);
            var request = await Fixture.Read(socket);
            Assert.True(JsonNode.DeepEquals(batch, request["args"]));
            await RespondEdit(socket, request);
            await native;
        }
        var single = Call(
            new JsonObject
            {
                ["filePath"] = "file",
                ["oldText"] = "old",
                ["newText"] = "$&",
                ["replaceAll"] = false,
            }
        );
        var edit = await Fixture.Read(socket);
        Assert.Equal("edit", edit["tool"]!.GetValue<string>());
        Assert.Equal(unified ? "$&" : "$$&", edit["args"]!["newText"]!.GetValue<string>());
        Assert.Null(edit["sessionId"]);
        Assert.Equal("external", edit["owner"]!["kind"]!.GetValue<string>());
        await RespondEdit(socket, edit);
        await single;
        const string patch = "*** Begin Patch\n*** Delete File: file\n*** End Patch";
        var patchCall = Call(new JsonObject { ["apply_patch"] = patch });
        var patchRequest = await Fixture.Read(socket);
        Assert.Equal(unified ? "edit" : "apply_patch", patchRequest["tool"]!.GetValue<string>());
        Assert.Equal(
            patch,
            patchRequest["args"]![unified ? "apply_patch" : "input"]!.GetValue<string>()
        );
        await RespondEdit(socket, patchRequest);
        await patchCall;
    }
}
