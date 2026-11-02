using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class WebUiSequenceRouteTests
{
    [Fact]
    public async Task Sequence_view_limits_scoped_identities_to_their_Sessions_and_hides_peers()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            "vector: false\ndbWorkers: false\naccess:\n  identities:\n"
                + "    viewer:\n      token: synthetic-sequence-viewer\n      surfaces:\n        webui: {sessions: [receiver]}\n"
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            "default: local/wire\nproviders:\n  local: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}\n"
        );
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "local/wire",
            "synthetic",
            "",
            713
        );
        await using var manager = new SessionManager(data, work, options, configuration.Models);
        await manager.LoadMainHostAsync();
        var receiver = await manager.CreateNamedAsync("main", "receiver", null, null);
        var hidden = await manager.CreateNamedAsync("main", "hidden-peer", null, null);
        receiver.Registry.TriggerOverride = _ => Task.CompletedTask;
        hidden.Registry.TriggerOverride = _ => Task.CompletedTask;
        var now = DateTimeOffset.UtcNow;
        await receiver.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                [
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(
                            new JsonObject
                            {
                                ["system"] =
                                    $"<foxwarm-message type=\"inter-agent\" sourceSessionId=\"{hidden.Id}\" deliverySeq=\"4.2\" time=\"{now:yyyy-MM-dd HH:mm:ss} +0000\" hint=\"inter-agent message from another session, not direct end-user input\">\nplan update\n</foxwarm-message>",
                            }
                        ),
                    },
                ],
                [],
                updateLastMessageTime: true,
                finalizing: false,
                () => now.ToUnixTimeMilliseconds()
            )
        );
        await hidden.Entry.SaveLane.AdmitAsync(QueueItem.UserText("private"), SaveKind.Strict);

        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(data, default);
        var runtime = new SessionRuntime(manager);
        var server = new HttpServer(
            [],
            0,
            "synthetic-sequence-admin",
            null,
            manager,
            terminals,
            webUiEnabled: true
        );
        new WebUIChannel(
            manager,
            runtime,
            new MessageRouter(runtime),
            terminals,
            server.Downloads
        ).Register(server.App);
        await server.App.StartAsync();
        try
        {
            HttpClient Client(string token)
            {
                var client = new HttpClient(new HttpClientHandler { UseCookies = false })
                {
                    BaseAddress = new Uri(server.App.Urls.Single() + "/"),
                };
                client.DefaultRequestHeaders.Authorization = new("Bearer", token);
                return client;
            }
            using var admin = Client("synthetic-sequence-admin");
            using var viewer = Client("synthetic-sequence-viewer");
            var since = now.ToUnixTimeMilliseconds() - 60_000;

            async Task<JsonObject> Read(HttpClient client, JsonObject body)
            {
                var response = await client.PostAsJsonAsync("api/session-sequence", body);
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                return (JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject)!;
            }
            static string[] Lanes(JsonObject result) =>
                result["sessions"]!
                    .AsArray()
                    .Select(row => SessionWait.Text(row!["id"])!)
                    .ToArray();

            var all = await Read(admin, new JsonObject { ["since"] = since });
            Assert.Contains(hidden.Id, Lanes(all));
            var adminLink = all["links"]!
                .AsArray()
                .Single(link => SessionWait.Text(link!["deliverySeq"]) == "4.2")!;
            Assert.Equal(hidden.Id, SessionWait.Text(adminLink["from"]!["sessionId"]));
            Assert.Equal("plan update", SessionWait.Text(adminLink["preview"]));

            var scoped = await Read(viewer, new JsonObject { ["since"] = since });
            Assert.Equal([receiver.Id], Lanes(scoped));
            var text = scoped.ToJsonString();
            Assert.DoesNotContain(hidden.Id, text);
            Assert.DoesNotContain("private", text);
            Assert.Null(scoped["tasks"]);
            var opaque = Assert.Single(scoped["peers"]!.AsArray())!;
            Assert.True(opaque["opaque"]!.GetValue<bool>());
            var link = scoped["links"]!
                .AsArray()
                .Single(item => SessionWait.Text(item!["deliverySeq"]) == "4.2")!;
            Assert.StartsWith("external:", SessionWait.Text(link["from"]!["sessionId"]));
            Assert.Equal(
                SessionWait.Text(opaque["id"]),
                SessionWait.Text(link["from"]!["sessionId"])
            );
            // The receiving Session is in scope, so the message it received stays readable.
            Assert.Equal("plan update", SessionWait.Text(link["preview"]));

            var outside = await Read(
                viewer,
                new JsonObject { ["since"] = since, ["sessionIds"] = new JsonArray(hidden.Id) }
            );
            Assert.Empty(Lanes(outside));
            var focused = await Read(
                viewer,
                new JsonObject { ["since"] = since, ["focusSessionId"] = hidden.Id }
            );
            Assert.Empty(Lanes(focused));

            var invalid = await viewer.PostAsJsonAsync(
                "api/session-sequence",
                new JsonObject { ["since"] = -1 }
            );
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        }
        finally
        {
            await server.App.StopAsync();
            await server.App.DisposeAsync();
        }
    }
}
