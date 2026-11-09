using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// WebUI input records who sent it; only the administrator can read that record.
public sealed class WebUiSenderTests
{
    private sealed class NoChat : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) => throw new InvalidOperationException("No model request is expected.");
    }

    private static JsonObject? Sender(JsonNode? message) =>
        message?["__meta"]?["sender"] as JsonObject;

    [Fact]
    public async Task Administrator_and_scoped_input_record_their_sender_and_only_the_administrator_reads_it()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        var app = ConfigurationYaml.Parse(
            "access:\n  identities: {alice: {token: synthetic-alice, surfaces: {webui: {sessions: [chat]}}}}\n",
            "app config"
        );
        app["vector"] = false;
        app["dbWorkers"] = false;
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            app.ToJsonString()
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            """
            {"default":"local","providers":{"local":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]}}}
            """
        );
        var config = new ModelConfiguration(data);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            Path.Combine(temp.Path, "work"),
            options,
            config.Models
        );
        await manager.LoadMainHostAsync();
        var chat = await manager.CreateNamedAsync("main", "chat", null, null);
        chat.Registry.TriggerOverride = _ => Task.CompletedTask;
        await using var terminals = new Foxwarm.Terminal.TerminalRegistry(data, default);
        var server = new HttpServer(
            [],
            0,
            "synthetic-admin",
            null,
            manager,
            terminals,
            webUiEnabled: true
        );
        var runtime = new SessionRuntime(manager);
        new WebUIChannel(
            manager,
            runtime,
            new MessageRouter(runtime),
            terminals,
            server.Downloads
        ).Register(server.App);
        await server.App.StartAsync();
        using var admin = new HttpClient { BaseAddress = new Uri(server.App.Urls.Single()) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-admin");
        using var alice = new HttpClient { BaseAddress = new Uri(server.App.Urls.Single()) };
        alice.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-alice");
        try
        {
            foreach (var (client, text) in new[] { (admin, "from admin"), (alice, "from alice") })
            {
                using var response = await client.PostAsJsonAsync(
                    "/api/sessions/chat/message",
                    new JsonObject { ["text"] = text }
                );
                Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
            }
            var queue = chat.Entry.Snapshot().Queue;
            Assert.Equal(2, queue.Count);
            Assert.Equal(
                "administrator",
                SessionWait.Text(queue[0].OpenFields?["sender"]?["kind"])
            );
            Assert.Equal("identity", SessionWait.Text(queue[1].OpenFields?["sender"]?["kind"]));
            Assert.Equal("alice", SessionWait.Text(queue[1].OpenFields?["sender"]?["id"]));

            // Commit the queued input through the ordinary canonical append.
            var host = new LocalSessionTurnHost(
                chat.Entry,
                chat.Registry.Store,
                new NoChat(),
                new UnsupportedTurnToolExecutor()
            );
            await host.AppendQueuedInputsAsync(
                chat.Entry.WithState(state => state.Queue.ToArray())
            );
            var users = chat.History()
                .Where(row => SessionWait.Text(row["role"]) == "user")
                .ToArray();
            Assert.Equal("administrator", SessionWait.Text(Sender(users[^2])?["kind"]));
            Assert.Equal("alice", SessionWait.Text(Sender(users[^1])?["id"]));
            // The model never sees the sender.
            var request = ConcreteRequestHistory.PrepareRequest(chat.History(), "wire");
            Assert.DoesNotContain(request, message => Sender(message) is not null);

            foreach (var path in new[] { "history", "history/continuous" })
            {
                var asAdmin = await admin.GetFromJsonAsync<JsonObject>(
                    "/api/sessions/chat/" + path
                );
                var asAlice = await alice.GetFromJsonAsync<JsonObject>(
                    "/api/sessions/chat/" + path
                );
                var adminMessages = asAdmin!["messages"]!.AsArray();
                var aliceMessages = asAlice!["messages"]!.AsArray();
                Assert.Contains(
                    adminMessages,
                    message => SessionWait.Text(Sender(message)?["id"]) == "alice"
                );
                Assert.Equal(adminMessages.Count, aliceMessages.Count);
                Assert.DoesNotContain(aliceMessages, message => Sender(message) is not null);
            }
            // The scoped projection never altered the stored record.
            Assert.NotNull(
                Sender(chat.History().Last(row => SessionWait.Text(row["role"]) == "user"))
            );
        }
        finally
        {
            await server.App.StopAsync();
            await server.App.DisposeAsync();
            await manager.ShutdownAsync();
        }
    }
}
