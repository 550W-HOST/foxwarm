using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class IsolationMigrationHttpTests
{
    [Fact]
    public async Task Administrator_routes_report_and_apply_isolation_migration_and_update_inheritable()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(f.Data, default);
        var server = new HttpServer(
            [],
            0,
            "synthetic-isolation-migration-token",
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
                "synthetic-isolation-migration-token"
            );
            foreach (var agent in new[] { "guarded", "plain" })
                Assert.Equal(
                    HttpStatusCode.Created,
                    (
                        await client.PostAsJsonAsync(
                            "/api/agents",
                            new JsonObject { ["agentId"] = agent }
                        )
                    ).StatusCode
                );
            // Record legacy isolation the way an older release left it; this release has no
            // setter, and startup migration has already run for this fixture.
            var catalog = (AgentCatalog)
                typeof(SessionManager)
                    .GetField(
                        "agents",
                        System.Reflection.BindingFlags.NonPublic
                            | System.Reflection.BindingFlags.Instance
                    )!
                    .GetValue(f.Manager)!;
            await catalog.MigrateMetadataAsync(metadata =>
            {
                metadata["guarded"] = new JsonObject
                {
                    ["isolated"] = true,
                    ["isolatedNode"] = "bound-node",
                };
                return true;
            });

            var inventory = await client.GetFromJsonAsync<JsonObject>(
                "/api/agents/isolation-migration"
            );
            var report = inventory!["agents"]!.AsArray().Single()!.AsObject();
            Assert.Equal("guarded", report["agent"]!.GetValue<string>());
            Assert.True(report["applicable"]!.GetValue<bool>());
            Assert.Equal(
                HttpStatusCode.NotFound,
                (await client.GetAsync("/api/agents/isolation-migration?agent=missing")).StatusCode
            );
            Assert.Null(f.Manager.AgentMetadata["guarded"]?["rules"]);

            var applied = await client.PostAsync("/api/agents/guarded/isolation-migration", null);
            Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
            var row = f.Manager.AgentMetadata["guarded"]!.AsObject();
            Assert.True(row["isolated"]!.GetValue<bool>());
            Assert.NotEmpty(row["rules"]!.AsArray());
            Assert.Equal("bound-node", row["defaultNode"]!.GetValue<string>());
            // A repeated apply reruns only the placement backfill.
            var repeated = await client.PostAsync("/api/agents/guarded/isolation-migration", null);
            Assert.Equal(HttpStatusCode.OK, repeated.StatusCode);
            Assert.False(
                (await repeated.Content.ReadFromJsonAsync<JsonObject>())![
                    "applied"
                ]!.GetValue<bool>()
            );
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (
                    await client.PostAsJsonAsync(
                        "/api/agents/guarded/isolation-migration",
                        new JsonObject { ["acknowledgeDescendants"] = "yes" }
                    )
                ).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (await client.PostAsync("/api/agents/plain/isolation-migration", null)).StatusCode
            );

            var listed = await client.GetFromJsonAsync<JsonObject>("/api/agents");
            var guarded = listed!["agents"]!
                .AsArray()
                .Single(agent => agent!["id"]!.GetValue<string>() == "guarded")!;
            Assert.False(guarded["inheritable"]!.GetValue<bool>());
            Assert.False(guarded["isolationMigration"]!["automatic"]!.GetValue<bool>());

            var flagged = await client.PutAsJsonAsync(
                "/api/agents/plain",
                new JsonObject { ["inheritable"] = false }
            );
            Assert.Equal(HttpStatusCode.OK, flagged.StatusCode);
            Assert.False(
                (await flagged.Content.ReadFromJsonAsync<JsonObject>())!["agent"]![
                    "inheritable"
                ]!.GetValue<bool>()
            );
            Assert.Equal(
                HttpStatusCode.BadRequest,
                (
                    await client.PutAsJsonAsync(
                        "/api/agents/plain",
                        new JsonObject { ["inheritable"] = "no" }
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
