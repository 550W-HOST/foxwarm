using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class AgentRulesTreeHttpTests
{
    [Fact]
    public async Task Trusted_administration_creates_roots_replaces_local_rules_and_keeps_creator_immutable()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(f.Data, default);
        var server = new HttpServer(
            [],
            0,
            "synthetic-agent-rules-token",
            null,
            f.Manager,
            terminals,
            webUiEnabled: true
        );
        var runtime = new SessionRuntime(f.Manager);
        new WebUIChannel(
            f.Manager,
            runtime,
            new MessageRouter(runtime),
            terminals,
            server.Downloads
        ).Register(server.App);
        await server.App.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new Uri(server.App.Urls.Single()) };
            client.DefaultRequestHeaders.Authorization = new(
                "Bearer",
                "synthetic-agent-rules-token"
            );
            var created = await client.PostAsJsonAsync(
                "/api/agents",
                new JsonObject
                {
                    ["agentId"] = "admin-root",
                    ["defaultNode"] = "offline-default",
                    ["rules"] = JsonNode.Parse("""[{"tool":"skill","action":"deny"}]"""),
                }
            );
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
            Assert.Null(f.Manager.AgentMetadata["admin-root"]?["createdBy"]);
            var owner = await f.Manager.RequiredAsync("admin-root/main");
            Assert.Equal("offline-default", f.Manager.CurrentNode(owner));
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                f.Manager.AuthorizeToolAsync(
                    owner,
                    new("skill", "builtin", "skill", new JsonObject { ["action"] = "list" }),
                    null,
                    default
                )
            );
            var updated = await client.PutAsJsonAsync(
                "/api/agents/admin-root",
                new JsonObject { ["rules"] = new JsonArray(), ["defaultNode"] = "later-default" }
            );
            Assert.Equal(HttpStatusCode.OK, updated.StatusCode);
            await f.Manager.AuthorizeToolAsync(
                owner,
                new("skill", "builtin", "skill", new JsonObject { ["action"] = "list" }),
                null,
                default
            );
            Assert.Equal("offline-default", f.Manager.CurrentNode(owner));
            var next = await f.Manager.CreateNamedAsync("admin-root", "next", null, null);
            Assert.Equal("later-default", f.Manager.CurrentNode(next));
            foreach (
                var bad in new[]
                {
                    new JsonObject { ["createdBy"] = "main" },
                    new JsonObject
                    {
                        ["rules"] = JsonNode.Parse("""[{"action":"deny","agent":"admin-root"}]"""),
                    },
                    new JsonObject { ["rules"] = null },
                }
            )
                Assert.Equal(
                    HttpStatusCode.BadRequest,
                    (await client.PutAsJsonAsync("/api/agents/admin-root", bad)).StatusCode
                );
            Assert.Empty(f.Manager.AgentMetadata["admin-root"]!["rules"]!.AsArray());
            await f.Manager.CreateAgentAsync("admin-child", creator: owner);
            var before = f.Manager.Catalog.List().Select(row => row["id"]!.ToString()).ToArray();
            var deletion = await client.SendAsync(
                new HttpRequestMessage(HttpMethod.Delete, "/api/agents/admin-root")
                {
                    Content = JsonContent.Create(new { confirmAgentId = "admin-root" }),
                }
            );
            Assert.False(deletion.IsSuccessStatusCode);
            Assert.Equal(before, f.Manager.Catalog.List().Select(row => row["id"]!.ToString()));
            var listing = await client.GetFromJsonAsync<JsonObject>("/api/agents");
            var child = listing!["agents"]!
                .AsArray()
                .Single(item => item!["id"]!.ToString() == "admin-child")!;
            Assert.Equal("admin-root", child["createdBy"]!.ToString());
            Assert.Equal(0, child["ruleCount"]!.GetValue<int>());
        }
        finally
        {
            await server.App.StopAsync();
            await server.App.DisposeAsync();
        }
    }

    [Fact]
    public async Task Explicit_administrator_restore_preserves_authority_without_reviving_deleted_Sessions_and_cleanup_checks_references()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        await f.Manager.CreateAgentAsync("parent", creator: f.Owner);
        var parent = await f.Manager.RequiredAsync("parent/main");
        var rules = JsonNode.Parse("""[{"tool":"skill","action":"deny"}]""")!.AsArray();
        await f.Manager.CreateAgentAsync(
            "child",
            creator: parent,
            rules: rules,
            defaultNode: "offline"
        );
        var childId = "child/main";
        var oldMemory = Path.Combine(f.Manager.AgentDirectory("child"), "memory", "MEMORY.md");
        await File.WriteAllTextAsync(oldMemory, "deleted memory is not restored");
        var metadata = f.Manager.AgentMetadata["child"]!.DeepClone();
        var router = new Foxwarm.MessageRouter(new SessionRuntime(f.Manager));
        await router.HandleMessageAsync(
            new Foxwarm.ChannelContext(f.Owner.Id, "webui"),
            new Foxwarm.ChannelMessage("/agent delete child --confirm", null)
        );
        Assert.DoesNotContain("child", f.Manager.Agents());
        await f.Configuration.Access.ApplyAsync(
            AccessConfiguration.Normalize(
                JsonNode.Parse(
                    """{"identities":{"limited":{"token":"synthetic-retained-limited","surfaces":{"webui":{"sessions":["parent/*"]}}}}}"""
                )!
            )
        );
        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(f.Data, default);
        var server = new HttpServer(
            [],
            0,
            "synthetic-retained-admin",
            null,
            f.Manager,
            terminals,
            webUiEnabled: true
        );
        var runtime = new SessionRuntime(f.Manager);
        new WebUIChannel(f.Manager, runtime, router, terminals, server.Downloads).Register(
            server.App
        );
        await server.App.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new Uri(server.App.Urls.Single()) };
            client.DefaultRequestHeaders.Authorization = new(
                "Bearer",
                "synthetic-retained-limited"
            );
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (
                    await client.PostAsJsonAsync(
                        "/api/agents",
                        new { agentId = "child", restore = true }
                    )
                ).StatusCode
            );
            var scopedDelete = new HttpRequestMessage(HttpMethod.Delete, "/api/agents/child")
            {
                Content = JsonContent.Create(new { confirmAgentId = "child", retainedOnly = true }),
            };
            Assert.Equal(
                HttpStatusCode.Forbidden,
                (await client.SendAsync(scopedDelete)).StatusCode
            );
            client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-retained-admin");
            Assert.False(
                (
                    await client.PostAsJsonAsync("/api/agents", new { agentId = "child" })
                ).IsSuccessStatusCode
            );
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (
                    await client.PostAsJsonAsync(
                        "/api/agents",
                        new JsonObject
                        {
                            ["agentId"] = "child",
                            ["restore"] = true,
                            ["rules"] = new JsonArray(),
                        }
                    )
                ).StatusCode
            );
            var restored = await client.PostAsJsonAsync(
                "/api/agents",
                new { agentId = "child", restore = true }
            );
            Assert.Equal(HttpStatusCode.Created, restored.StatusCode);
            var result = await restored.Content.ReadFromJsonAsync<JsonObject>();
            Assert.Null(result!["sessionId"]);
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (
                    await client.PutAsJsonAsync(
                        "/api/agents/child",
                        new JsonObject { ["restore"] = true, ["rules"] = new JsonArray() }
                    )
                ).StatusCode
            );
            Assert.True(JsonNode.DeepEquals(metadata, f.Manager.AgentMetadata["child"]));
            Assert.Null(await f.Manager.GetExistingAsync(childId));
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Manager.CreateNamedAsync("child", "main", null, null)
            );
            Assert.False(File.Exists(oldMemory));
            var fresh = await f.Manager.CreateNamedAsync("child", "fresh", null, null);
            Assert.Equal("offline", f.Manager.CurrentNode(fresh));
            await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                f.Manager.AuthorizeToolAsync(
                    fresh,
                    new("skill", "builtin", "skill", new JsonObject { ["action"] = "list" }),
                    null,
                    default
                )
            );
            await f.Manager.DeleteAgentFromCommandAsync("child");
            // Parent deletion stays blocked until its retained child record is explicitly cleaned.
            var parentDeletion = await client.SendAsync(
                new HttpRequestMessage(HttpMethod.Delete, "/api/agents/parent")
                {
                    Content = JsonContent.Create(new { confirmAgentId = "parent" }),
                }
            );
            Assert.False(parentDeletion.IsSuccessStatusCode);
            var cleanup = await client.SendAsync(
                new HttpRequestMessage(HttpMethod.Delete, "/api/agents/child")
                {
                    Content = JsonContent.Create(
                        new { confirmAgentId = "child", retainedOnly = true }
                    ),
                }
            );
            Assert.Equal(HttpStatusCode.OK, cleanup.StatusCode);
            Assert.Null(f.Manager.AgentMetadata["child"]);
            Assert.Equal(
                HttpStatusCode.OK,
                (
                    await client.SendAsync(
                        new HttpRequestMessage(HttpMethod.Delete, "/api/agents/parent")
                        {
                            Content = JsonContent.Create(new { confirmAgentId = "parent" }),
                        }
                    )
                ).StatusCode
            );
        }
        finally
        {
            await server.App.StopAsync();
            await server.App.DisposeAsync();
        }
    }
}
