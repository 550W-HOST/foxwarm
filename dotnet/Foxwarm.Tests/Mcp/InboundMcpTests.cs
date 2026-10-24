using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using ModelContextProtocol.Protocol;

namespace Foxwarm.Tests;

public sealed class InboundMcpTests
{
    private static string Text(JsonObject value) =>
        value["content"]![0]!["text"]!.GetValue<string>();

    private static JsonObject Value(JsonObject value) => value["structuredContent"]!.AsObject();

    [Fact]
    public async Task Official_Csharp_client_uses_five_wrappers_real_external_owners_and_raw_outbound_results()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "peer",
                ["url"] = peer.Url + "/mcp",
                ["transport"] = "streamable-http",
            },
            default
        );
        await using var alpha = await f.ClientAsync();
        await using var beta = await f.ClientAsync(InboundMcpFixture.Beta);
        var tools = await alpha.ListToolsAsync(new ListToolsRequestParams());
        Assert.Equal(5, tools.Tools.Count);
        Assert.Equal(
            "2025-11-25",
            alpha.ServerInfo is not null ? alpha.NegotiatedProtocolVersion : null
        );
        var discovery = Value(
            await InboundMcpFixture.CallAsync(
                alpha,
                "foxwarm_discover",
                new JsonObject { ["sources"] = new JsonArray("mcp"), ["limit"] = 20 }
            )
        );
        Assert.Contains(
            discovery["tools"]!.AsArray(),
            item => item!["toolId"]!.GetValue<string>() == "mcp:peer/probe"
        );
        var first = JsonNode.Parse(
            Text(await InboundMcpFixture.ConcreteAsync(alpha, "mcp:peer/probe"))
        )!["id"]!.GetValue<string>();
        var again = JsonNode.Parse(
            Text(await InboundMcpFixture.ConcreteAsync(alpha, "mcp:peer/probe"))
        )!["id"]!.GetValue<string>();
        var second = JsonNode.Parse(
            Text(await InboundMcpFixture.ConcreteAsync(beta, "mcp:peer/probe"))
        )!["id"]!.GetValue<string>();
        Assert.Equal(first, again);
        Assert.NotEqual(first, second);
        Assert.Equal(
            2,
            (await peer.EventsAsync()).Count(row => row["kind"]!.GetValue<string>() == "initialize")
        );
        foreach (
            var kind in new[]
            {
                "duplicate",
                "image",
                "meta",
                "error",
                "audio",
                "resource",
                "opaque",
            }
        )
        {
            var result = await InboundMcpFixture.ConcreteAsync(
                alpha,
                "mcp:peer/result",
                new JsonObject { ["kind"] = kind }
            );
            Assert.NotNull(result["content"]);
            if (kind == "duplicate")
            {
                Assert.NotNull(result["structuredContent"]);
                Assert.Single(result["content"]!.AsArray());
            }
            if (kind == "image")
            {
                Assert.Equal("image", result["content"]![1]!["type"]!.GetValue<string>());
                Assert.NotNull(result["content"]![1]!["annotations"]);
            }
            if (kind == "error")
                Assert.True(result["isError"]!.GetValue<bool>());
            if (kind == "meta")
                Assert.True(result["_meta"]!["retained"]!.GetValue<bool>());
            if (kind == "opaque")
                Assert.True(result["customTag"]!["retained"]!.GetValue<bool>());
        }
        var denied = await InboundMcpFixture.ConcreteAsync(
            alpha,
            "builtin:exec",
            new JsonObject { ["command"] = "no" }
        );
        Assert.True(denied["isError"]!.GetValue<bool>());
        using (var deletion = f.Request("DELETE", alpha.SessionId))
            Assert.Equal(HttpStatusCode.OK, (await f.Http.SendAsync(deletion)).StatusCode);
        Assert.Single(await peer.EventsAsync(), row => row["kind"]!.GetValue<string>() == "delete");
        Assert.Contains("id", Text(await InboundMcpFixture.ConcreteAsync(beta, "mcp:peer/probe")));
    }

    [Fact]
    public async Task Malformed_known_protocol_fields_return_valid_uncertain_errors_after_one_effect_without_retiring_context()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "peer",
                ["url"] = peer.Url + "/mcp",
                ["transport"] = "streamable-http",
            },
            default
        );
        await using var client = await f.ClientAsync();
        string[] invalid =
        [
            "{\"content\":\"invalid-content\",\"isError\":\"not-a-boolean\"}",
            "{\"content\":[] ,\"isError\":\"not-a-boolean\"}",
            "{\"content\":null}",
            "{\"content\":[null]}",
            "{\"isError\":null}",
            "{\"structuredContent\":42}",
            "{\"structuredContent\":null}",
            "{\"_meta\":null}",
            "{\"_meta\":{\"progressToken\":1.5}}",
            "{\"content\":[{\"type\":\"text\"}]}",
            "{\"content\":[{\"type\":\"text\",\"text\":null}]}",
            "{\"content\":[{\"type\":\"image\",\"data\":\"AA==\"}]}",
            "{\"content\":[{\"type\":\"audio\",\"data\":42,\"mimeType\":\"audio/wav\"}]}",
            "{\"content\":[{\"type\":\"image\",\"data\":\"AA=\",\"mimeType\":\"image/png\"}]}",
            "{\"content\":[{\"type\":\"text\",\"text\":\"ok\",\"annotations\":{\"priority\":2}}]}",
            "{\"content\":[{\"type\":\"text\",\"text\":\"ok\",\"annotations\":{\"audience\":[1]}}]}",
            "{\"content\":[{\"type\":\"text\",\"text\":\"ok\",\"annotations\":{\"lastModified\":\"2026-02-29T12:00Z\"}}]}",
            "{\"content\":[{\"type\":\"resource\",\"resource\":{\"text\":\"missing uri\"}}]}",
            "{\"content\":[{\"type\":\"resource_link\",\"uri\":\"x\",\"name\":\"x\",\"icons\":[null]}]}",
            "{\"content\":[{\"type\":\"resource_link\",\"uri\":\"x\",\"name\":\"x\",\"icons\":[{\"src\":\"x\",\"theme\":\"other\"}]}]}",
            "{\"content\":[{\"type\":\"tool_use\",\"id\":\"x\",\"name\":\"x\",\"input\":{}}]}",
        ];
        for (var i = 0; i < invalid.Length; i++)
        {
            var tag = "invalid-" + i;
            // Fail this regression before the downstream production call budget elapses.
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var result = await client.CallToolAsync(
                new CallToolRequestParams
                {
                    Name = "foxwarm_call",
                    Arguments = new Dictionary<string, JsonElement>
                    {
                        ["toolId"] = JsonSerializer.SerializeToElement("mcp:peer/result"),
                        ["args"] = JsonSerializer.SerializeToElement(
                            new JsonObject
                            {
                                ["rawResult"] = JsonNode.Parse(invalid[i]),
                                ["tag"] = tag,
                            }
                        ),
                    },
                },
                cancellationToken: deadline.Token
            );
            Assert.False(deadline.IsCancellationRequested, invalid[i]);
            Assert.True(result.IsError, invalid[i]);
            var text = Assert.IsType<TextContentBlock>(Assert.Single(result.Content)).Text;
            Assert.Contains("outcome may be unknown", text);
            Assert.Contains("do not retry automatically", text);
            Assert.Single(
                await peer.EventsAsync(),
                row =>
                    row["kind"]!.GetValue<string>() == "effect"
                    && row["tag"]?.GetValue<string>() == tag
            );
        }
        using var healthyDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        Assert.Equal(
            5,
            (await client.ListToolsAsync(new ListToolsRequestParams(), healthyDeadline.Token))
                .Tools
                .Count
        );
        Assert.Contains(
            "id",
            Text(
                await InboundMcpFixture
                    .ConcreteAsync(client, "mcp:peer/probe")
                    .WaitAsync(healthyDeadline.Token)
            )
        );
        var events = await peer.EventsAsync();
        Assert.Single(events, row => row["kind"]!.GetValue<string>() == "initialize");
        Assert.DoesNotContain(
            events,
            row => row["kind"]!.GetValue<string>() is "cancelled" or "delete" or "closed"
        );
    }

    [Fact]
    public async Task Protocol_validation_preserves_Source_valid_opaque_fields_media_and_resource_union_data()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "peer",
                ["url"] = peer.Url + "/mcp",
                ["transport"] = "streamable-http",
            },
            default
        );
        await using var client = await f.ClientAsync();
        var raw = JsonNode.Parse(
            """
            {
              "content": [
                {"type":"text","text":"untouched","isError":"business","data":{"opaque":true},
                 "annotations":{"audience":["assistant"],"priority":0.25,"lastModified":"2026-10-18T12:34:56.123456789+99:99","extra":{"retained":true}},"_meta":{"retained":true}},
                {"type":"image","data":"AA","mimeType":"image/png","_meta":{"image":true}},
                {"type":"audio","data":"AA\n==","mimeType":"audio/wav","extension":[0,false,null]},
                {"type":"resource_link","uri":"ordinary-resource","name":"resource","size":"business","icons":[{"src":"ordinary-icon","theme":"dark","sizes":["any"],"custom":true}]},
                {"type":"resource","resource":{"uri":"ordinary-text","text":"text wins","blob":{"opaque":true},"_meta":{"retained":true}}},
                {"type":"resource","resource":{"uri":"ordinary-blob","text":false,"blob":"AA"}}
              ],
              "structuredContent":{"arbitrary":[null,false,42]},"_meta":{"progressToken":"p","retained":true},
              "customTag":{"retained":true},"error":{"business":true},"canceled":true,"__cancelAllToolsThisTurn":true
            }
            """
        )!;
        foreach (var value in new[] { new JsonObject(), raw })
        {
            var result = await InboundMcpFixture.ConcreteAsync(
                client,
                "mcp:peer/result",
                new JsonObject
                {
                    ["rawResult"] = value.DeepClone(),
                    ["tag"] = "valid-" + value.AsObject().Count,
                }
            );
            Assert.True(JsonNode.DeepEquals(value, result), result.ToJsonString());
        }
        Assert.Equal(
            2,
            (await peer.EventsAsync()).Count(row => row["kind"]!.GetValue<string>() == "effect")
        );
    }

    [Fact]
    public async Task Nonzero_base64_pad_bits_preserve_original_media_after_one_effect_and_retain_context()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await OutboundSdkPeer.StartAsync(Path.Combine(f.Temp.Path, "peer"));
        await f.Manager.OutboundMcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "peer",
                ["url"] = peer.Url + "/mcp",
                ["transport"] = "streamable-http",
            },
            default
        );
        await using var client = await f.ClientAsync();
        foreach (var type in new[] { "image", "audio", "resource" })
        foreach (var data in new[] { "AB", "AB==" })
        {
            var block =
                type == "resource"
                    ? new JsonObject
                    {
                        ["type"] = type,
                        ["resource"] = new JsonObject
                        {
                            ["uri"] = "ordinary-blob",
                            ["blob"] = data,
                        },
                    }
                    : new JsonObject
                    {
                        ["type"] = type,
                        ["data"] = data,
                        ["mimeType"] = type == "image" ? "image/png" : "audio/wav",
                    };
            var expected = new JsonObject { ["content"] = new JsonArray(block) };
            var tag = type + "-" + data;
            // The SDK raw-response API parses the actual JSON-RPC wire without
            // imposing its typed content parser's separate Base64 restriction.
            var result = await InboundMcpFixture.ConcreteAsync(
                client,
                "mcp:peer/result",
                new JsonObject { ["rawResult"] = expected.DeepClone(), ["tag"] = tag }
            );
            Assert.True(JsonNode.DeepEquals(expected, result), result.ToJsonString());
            Assert.Single(
                await peer.EventsAsync(),
                row =>
                    row["kind"]!.GetValue<string>() == "effect"
                    && row["tag"]?.GetValue<string>() == tag
            );
        }
        Assert.Equal(5, (await client.ListToolsAsync(new ListToolsRequestParams())).Tools.Count);
        Assert.Contains(
            "id",
            Text(await InboundMcpFixture.ConcreteAsync(client, "mcp:peer/probe"))
        );
        Assert.Single(
            await peer.EventsAsync(),
            row => row["kind"]!.GetValue<string>() == "initialize"
        );
    }

    [Fact]
    public async Task External_raw_validation_runs_inside_existing_OAuth_guard_and_preserves_binary_media_without_weakening_internal_checks()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var peer = await McpOAuthPeer.StartAsync();
        var mcp = f.Manager.OutboundMcp;
        await mcp.ConfigureAsync(
            new JsonObject
            {
                ["name"] = "peer",
                ["url"] = peer.Resource,
                ["transport"] = "streamable-http",
            },
            default
        );
        await mcp.SetAuthorizationAsync(
            "peer",
            new JsonObject
            {
                ["authentication"] = "oauth",
                ["scope"] = "read",
                ["clientId"] = "pre-registered",
                ["clientSecret"] = "AA==",
            }
        );
        await peer.AuthorizeAsync(mcp);
        var context = new McpExternalContext(
            McpExternalPrincipal.Authenticate(f.Configuration.Access, InboundMcpFixture.Alpha)!
        );
        var authorization = new McpExternalAuthorization(f.Manager.Authorization, f.Work);
        try
        {
            Assert.Contains(
                await mcp.ListExternalToolsAsync(context, authorization, "peer", default),
                tool => tool["name"]!.GetValue<string>() == "state"
            );
            await peer.SetAsync(new JsonObject { ["imageData"] = "AA==" });
            var media = await mcp.CallExternalAsync(
                context,
                authorization,
                "peer",
                "state",
                new(),
                default
            );
            Assert.Equal("AA==", media["content"]![0]!["data"]!.GetValue<string>());
            Assert.NotNull(
                await mcp.CallAsync(
                    "peer",
                    "state",
                    new(),
                    default,
                    f.Target,
                    f.Target.McpGeneration
                )
            );
            await peer.SetAsync(new JsonObject { ["imageData"] = null, ["echoCredential"] = true });
            await Assert.ThrowsAsync<McpInboundSafeException>(() =>
                mcp.CallExternalAsync(context, authorization, "peer", "state", new(), default)
            );
            await Assert.ThrowsAnyAsync<Exception>(() =>
                mcp.CallAsync("peer", "state", new(), default, f.Target, f.Target.McpGeneration)
            );
        }
        finally
        {
            context.Fence();
            await mcp.ReleaseExternalAsync(context);
            context.Lifetime.Dispose();
        }
    }

    [Fact]
    public async Task External_default_deny_is_concrete_and_durable_User_ingress_has_no_internal_source_or_reply()
    {
        await using var f = await InboundMcpFixture.CreateAsync(allow: false);
        await using var client = await f.ClientAsync();
        var denied = await InboundMcpFixture.CallAsync(
            client,
            "foxwarm_session",
            new JsonObject { ["action"] = "list" }
        );
        Assert.True(denied["isError"]!.GetValue<bool>());
        await f.PolicyAsync(
            "version: 1\nrules:\n  - id: session\n    action: allow\n    match:\n      externalId: alpha\n      tool: {source: builtin, name: [session, view_session, send_to_session]}\n"
        );
        var listed = Value(
            await InboundMcpFixture.CallAsync(
                client,
                "foxwarm_session",
                new JsonObject { ["action"] = "list", ["count"] = 1 }
            )
        );
        Assert.Equal(1, listed["count"]!.GetValue<int>());
        var sent = await InboundMcpFixture.CallAsync(
            client,
            "foxwarm_session",
            new JsonObject
            {
                ["action"] = "send",
                ["sessionId"] = f.Target.Id,
                ["message"] = "untouched <xml> \"text\"",
                ["allowReply"] = false,
            }
        );
        Assert.True(Value(sent)["accepted"]!.GetValue<bool>());
        var item = Assert.Single(f.Target.Entry.Snapshot().Queue);
        Assert.Equal(QueueItemType.User, item.Type);
        Assert.Null(item.Source);
        Assert.Null(item.SourceSessionId);
        Assert.Equal("untouched <xml> \"text\"", item.Parts![1]["text"]!.GetValue<string>());
        Assert.Contains("external-input", item.Parts[0]["system"]!.GetValue<string>());
        Assert.DoesNotContain("channelTargetId", item.Parts[0]["system"]!.GetValue<string>());
        var persisted = File.ReadAllText(
            Path.Combine(f.Data, "state", "sessions", f.Target.Id + ".json")
        );
        Assert.Contains("untouched", persisted);
        foreach (
            var args in new[]
            {
                new JsonObject
                {
                    ["action"] = "send",
                    ["sessionId"] = f.Target.Id,
                    ["message"] = "reply",
                    ["allowReply"] = true,
                },
                new JsonObject
                {
                    ["action"] = "send",
                    ["sessionId"] = f.Target.Id,
                    ["message"] = "conflict",
                    ["allowReply"] = false,
                    ["reply"] = true,
                },
                new JsonObject
                {
                    ["action"] = "send",
                    ["sessionId"] = "<main>",
                    ["message"] = "alias",
                },
            }
        )
            Assert.True(
                (await InboundMcpFixture.CallAsync(client, "foxwarm_session", args))[
                    "isError"
                ]!.GetValue<bool>()
            );
        Assert.Single(f.Target.Entry.Snapshot().Queue);
        var read = Value(
            await InboundMcpFixture.CallAsync(
                client,
                "foxwarm_session",
                new JsonObject { ["action"] = "read", ["sessionId"] = f.Target.Id }
            )
        );
        Assert.Equal(0, read["count"]!.GetValue<int>());
        Assert.NotNull(read["preview"]);
        Assert.Null(read["messages"]);
        Assert.Null(read["queue"]);
        Assert.Null(read["persistentMemorySnapshot"]);
    }

    [Theory]
    [InlineData(null, 10, 0, 3)]
    [InlineData(2L, 10, 2, 1)]
    [InlineData(-2L, 10, 1, 2)]
    [InlineData(3L, 10, 3, 0)]
    public async Task Session_read_counts_the_selected_messages_not_the_limit_or_preview(
        long? start,
        int count,
        int expectedStart,
        int expectedCount
    )
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        f.Target.Entry.WithState(state =>
        {
            for (var seq = 1; seq <= 3; seq++)
                state.History.Add(
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(
                            new JsonObject { ["text"] = new string('x', 2000) }
                        ),
                        ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq },
                    }
                );
            state.NextMessageSeq = 4;
        });
        await f.Target.Entry.SaveLane.SaveStrictAsync();
        await using var client = await f.ClientAsync();
        var args = new JsonObject
        {
            ["action"] = "read",
            ["sessionId"] = f.Target.Id,
            ["count"] = count,
            ["previewLength"] = 1000,
        };
        if (start is not null)
            args["start"] = start;
        var read = Value(await InboundMcpFixture.CallAsync(client, "foxwarm_session", args));
        Assert.Equal(expectedStart, read["start"]!.GetValue<int>());
        Assert.Equal(expectedCount, read["count"]!.GetValue<int>());
        Assert.Equal(3, read["total"]!.GetValue<int>());
    }

    [Fact]
    public async Task Every_HTTP_method_reauthenticates_origin_and_owner_and_selective_rotation_keeps_sibling_context()
    {
        await using var f = await InboundMcpFixture.CreateAsync();
        await using var alpha = await f.ClientAsync();
        await using var beta = await f.ClientAsync(InboundMcpFixture.Beta);
        foreach (var method in new[] { "POST", "GET", "DELETE" })
        {
            using var invalid = f.Request(
                method,
                alpha.SessionId,
                InboundMcpFixture.Admin,
                method == "POST" ? "{}" : null
            );
            Assert.Equal(HttpStatusCode.Unauthorized, (await f.Http.SendAsync(invalid)).StatusCode);
            using var crossed = f.Request(
                method,
                alpha.SessionId,
                InboundMcpFixture.Beta,
                method == "POST" ? "{}" : null
            );
            Assert.Equal(HttpStatusCode.NotFound, (await f.Http.SendAsync(crossed)).StatusCode);
            using var foreign = f.Request(
                method,
                alpha.SessionId,
                body: method == "POST" ? "{}" : null
            );
            foreign.Headers.Add("Origin", "https://foreign.invalid");
            Assert.Equal(HttpStatusCode.Forbidden, (await f.Http.SendAsync(foreign)).StatusCode);
        }
        using (var replay = f.Request("GET", alpha.SessionId))
        {
            replay.Headers.Add("Last-Event-ID", "unsupported-replay");
            Assert.Equal(HttpStatusCode.BadRequest, (await f.Http.SendAsync(replay)).StatusCode);
        }
        await f.Configuration.Access.ApplyAsync(
            AccessConfiguration.Normalize(InboundMcpFixture.App(webui: true)["access"])
        );
        Assert.False(
            (
                await InboundMcpFixture.CallAsync(
                    alpha,
                    "foxwarm_session",
                    new JsonObject { ["action"] = "list" }
                )
            )["isError"]
                ?.GetValue<bool>()
                ?? false
        );
        await f.Configuration.Access.ApplyAsync(
            AccessConfiguration.Normalize(
                InboundMcpFixture.App("synthetic-rotated-alpha")["access"]
            )
        );
        using var stale = f.Request("DELETE", alpha.SessionId);
        Assert.Equal(HttpStatusCode.Unauthorized, (await f.Http.SendAsync(stale)).StatusCode);
        Assert.NotNull(await beta.ListToolsAsync(new ListToolsRequestParams()));
    }
}
