using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Secrets;
using Foxwarm.Storage;
using Foxwarm.Tests.Models;

namespace Foxwarm.Tests.Hosted;

// With the tenant's journal off, no copy of a model interaction is kept anywhere: not in the
// database and not as wire diagnostics in scratch.
public sealed partial class HostedStartupTests
{
    [Fact]
    public async Task WithTheJournalOffNoModelInteractionIsWrittenToScratch()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        await database.ExecuteOwnerAsync("UPDATE tenants SET settings = '{\"journal\": {\"enabled\": false}}'");
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        // The first request answers; every later one (the second turn, background requests such
        // as a title) is rejected without retries.
        await using var model = new ScriptedResponsesSequenceServer(
            8,
            async (index, stream, _) =>
            {
                if (index == 0)
                    await RespondAsync(
                        stream,
                        new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = "first secret answer" }
                                ),
                            }
                        )
                    );
                else
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        400,
                        "application/json",
                        Encoding.UTF8.GetBytes("{\"error\":{\"message\":\"synthetic rejection\"}}")
                    );
            }
        );
        IStorageContext? storage = null;
        var replica = StartHosted(
            database.OpenApp(),
            files,
            built => storage = built,
            deploymentExtra: "egress: {allow: {hosted: [127.0.0.1]}}\n"
        );
        await WaitUntilAsync(
            () => replica.Inner.Health.Role == ReplicaRole.Owner && replica.Inner.Health.RuntimeStarted,
            TimeSpan.FromSeconds(60),
            "the hosted runtime serves"
        );
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{replica.PublicPort}"),
            Timeout = TimeSpan.FromSeconds(20),
        };
        client.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            storage!.Credentials.Read(InstanceCredentialName.HttpToken)
        );
        var models =
            $"default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: {model.BaseUri}\n    models: [wire]\n";
        Assert.True((await client.PostAsJsonAsync("api/setup/models", new { yaml = models })).IsSuccessStatusCode);
        Assert.True(
            (await client.PostAsJsonAsync("api/sessions", new { agentId = "main", sessionId = "quiet" })).IsSuccessStatusCode
        );
        string History() => client.GetStringAsync("api/sessions/quiet/history").GetAwaiter().GetResult();
        Assert.Equal(
            HttpStatusCode.Accepted,
            (await client.PostAsJsonAsync("api/sessions/quiet/message", new { text = "First secret question." })).StatusCode
        );
        await WaitUntilAsync(() => History().Contains("first secret answer"), TimeSpan.FromSeconds(30), "the first turn");
        Assert.Equal(
            HttpStatusCode.Accepted,
            (await client.PostAsJsonAsync("api/sessions/quiet/message", new { text = "Second secret question." })).StatusCode
        );
        await WaitUntilAsync(() => model.RequestCount >= 2, TimeSpan.FromSeconds(30), "the second request");
        var sessions = ((MainHostRuntime)replica.Runtimes.Single()).Host.Sessions;
        var owner = (await sessions.GetExistingAsync("quiet"))!;
        await Task.Delay(500);
        await WaitUntilAsync(() => !owner.Entry.Snapshot().Busy, TimeSpan.FromSeconds(30), "the failed turn ends");

        Assert.Equal(0, ((Foxwarm.Hosted.Postgres.PgLlmJournalStore)sessions.Journal).UnrecordedLiveCount);
        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        // No wire diagnostics: neither the recent files nor the failure directory.
        var logs = Path.Combine(files.Scratch, "state", "logs");
        var diagnostics = Directory.Exists(logs)
            ? Directory
                .EnumerateFiles(logs, "*.json", SearchOption.AllDirectories)
                .Select(path => Path.GetRelativePath(logs, path))
                .ToArray()
            : [];
        Assert.Empty(diagnostics);
        foreach (var path in Directory.EnumerateFiles(files.Scratch, "*", SearchOption.AllDirectories))
            Assert.DoesNotContain("secret question", File.ReadAllText(path));
        // Nor in the database: only the usage row of the successful request.
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM llm_journal_requests"));
        Assert.Equal(0L, await database.ScalarAsync("SELECT count(*) FROM llm_journal_attempt_results"));
        Assert.Equal(1L, await database.ScalarAsync("SELECT count(*) FROM llm_usage"));
    }
}
