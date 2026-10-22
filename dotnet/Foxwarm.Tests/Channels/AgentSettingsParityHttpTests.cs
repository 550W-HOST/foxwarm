using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class AgentSettingsParityHttpTests
{
    [Fact]
    public async Task Authenticated_settings_routes_normalize_aliases_effort_and_precedence_without_loosening_internal_settings()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(f.Data, default);
        var server = new HttpServer(
            [],
            0,
            "synthetic-settings-token",
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
            client.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-settings-token");
            async Task Post(string suffix, JsonObject body)
            {
                var response = await client.PostAsJsonAsync(
                    "/api/sessions/" + Uri.EscapeDataString(f.Owner.Id) + "/" + suffix,
                    body
                );
                Assert.True(
                    response.IsSuccessStatusCode,
                    await response.Content.ReadAsStringAsync()
                );
            }
            await Post(
                "child-model",
                new JsonObject
                {
                    ["childModelDefault"] = "local/wire",
                    ["effort"] = "\ufeff HIGH \ufeff",
                }
            );
            var envelope = f.Owner.Entry.Snapshot().AuthorityEnvelope;
            Assert.Equal("local/wire", envelope["childModelDefault"]!.ToString());
            Assert.Equal("high", envelope["childEffortDefault"]!.ToString());
            // Canonical child keys win even when their value means clear; clear=true does not defeat an explicit model.
            await Post(
                "child-model",
                new JsonObject
                {
                    ["childModelDefault"] = null,
                    ["model"] = "local/wire",
                    ["clear"] = true,
                    ["childEffortDefault"] = " UnSeT ",
                    ["effort"] = "high",
                }
            );
            envelope = f.Owner.Entry.Snapshot().AuthorityEnvelope;
            Assert.Null(envelope["childModelDefault"]);
            Assert.Null(envelope["childEffortDefault"]);
            await Post("model", new JsonObject { ["effort"] = " LOW " });
            Assert.Equal("low", f.Owner.Entry.Snapshot().AuthorityEnvelope["effort"]!.ToString());
            foreach (var unset in new string?[] { "default", " UnSeT ", " ", null })
            {
                await Post("model", new JsonObject { ["effort"] = unset });
                Assert.Null(f.Owner.Entry.Snapshot().AuthorityEnvelope["effort"]);
            }
            await Post(
                "model",
                new JsonObject { ["model"] = "\ufeff local/wire \ufeff", ["clear"] = true }
            );
            Assert.Equal(
                "local/wire",
                f.Owner.Entry.Snapshot().AuthorityEnvelope["model"]!.ToString()
            );
            await Post(
                "child-model",
                new JsonObject { ["model"] = "local/wire", ["childEffortDefault"] = "high" }
            );
            await Post(
                "child-model",
                new JsonObject { ["model"] = "clear", ["effort"] = "default" }
            );
            Assert.Null(f.Owner.Entry.Snapshot().AuthorityEnvelope["childModelDefault"]);
            foreach (
                var invalid in new JsonObject[]
                {
                    new() { ["effort"] = "turbo" },
                    new() { ["effort"] = 42 },
                    new() { ["effort"] = "\u0085high\u0085" },
                    new() { ["model"] = "\u0085local/wire\u0085" },
                    new() { ["model"] = "missing/model" },
                    new() { ["extra"] = true },
                }
            )
            {
                var response = await client.PostAsJsonAsync(
                    "/api/sessions/" + f.Owner.Id + "/model",
                    invalid
                );
                Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            }
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Owner.UpdateModelAsync(new JsonObject { ["effort"] = "default" })
            );
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                f.Owner.UpdateSettingsAsync(new JsonObject { ["effort"] = "high" }, child: true)
            );
            var disk = JsonNode.Parse(
                await File.ReadAllTextAsync(f.Owner.AuthorityStore.AuthorityPath)
            )!;
            Assert.Null(disk["childModelDefault"]);
            Assert.Null(disk["childEffortDefault"]);
            f.Manager.Nodes.Registry.Create("inherit-bound");
            await f.Manager.CreateAgentAsync(
                "isolated-source",
                false,
                isolatedNode: "inherit-bound"
            );
            var inherited = await client.PutAsJsonAsync(
                "/api/agents/main",
                new { inheritAgent = "isolated-source" }
            );
            Assert.Equal(HttpStatusCode.BadRequest, inherited.StatusCode);
            Assert.Contains(
                "is isolated and cannot be used as an inherit source",
                await inherited.Content.ReadAsStringAsync()
            );
            Assert.Null(f.Manager.AgentInherit("main"));
        }
        finally
        {
            await server.App.StopAsync();
            await server.App.DisposeAsync();
        }
    }
}
