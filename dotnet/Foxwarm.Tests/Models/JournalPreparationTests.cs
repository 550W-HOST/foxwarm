using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests.Models;

public sealed class JournalPreparationTests
{
    [Fact]
    public async Task Concurrent_owned_requests_keep_canonical_identity_and_bounded_delta_reconstruction()
    {
        using var temp = new TempDirectory();
        using var journal = new LlmRequestJournalStore(temp.Path);
        await journal.InitializeAsync();
        using var start = new ManualResetEventSlim();
        var callers = Enumerable.Range(0, 8).Select(session => Task.Run(async () =>
        {
            start.Wait();
            var history = new List<JsonObject>();
            for (var iteration = 0; iteration < 11; iteration++)
            {
                var message = new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject
                    {
                        ["text"] = $"{session}/{iteration}: NBSP\u00a0😀\uD83D",
                        ["opaque"] = JsonNode.Parse("{\"10\":1e-7,\"2\":-0,\"nested\":[true,null]}")
                    }),
                    ["__meta"] = new JsonObject { ["timestamp"] = iteration },
                    ["modelVisible"] = true
                };
                history.Add(message);
                var before = history.Select(LlmRequestJournalStore.EncodeCli).ToArray();
                var tools = JsonNode.Parse("[{\"name\":\"read\",\"parameters\":{\"type\":\"object\"}}]")!.AsArray();
                var id = await journal.BeginRequestAsync($"session-{session}", "normal-turn", iteration,
                    "prompt\uD83D", tools, history, "model", "cache");
                Assert.Equal(before, history.Select(LlmRequestJournalStore.EncodeCli));
                var payload = new JsonObject { ["input"] = new JsonArray(history.Select(row => row.DeepClone()).ToArray()) };
                var expectedHash = Digest(LlmRequestJournalStore.EncodeCli(payload));
                await journal.AppendAttemptStartAsync(id, 1, "model", null, "responses", payload, "prompt\uD83D");
                var result = new JsonObject { ["text"] = $"result-{session}-{iteration}" };
                await journal.AppendAttemptResultAsync(id, 1, "success", result, null);
                // Callers retain their JSON; completed preparation must not retain mutable references.
                tools.Clear();
                payload.Clear();
                result.Clear();
                var restored = await journal.ReconstructAsync(id);
                Assert.Equal("complete", restored["completeness"]!.GetValue<string>());
                Assert.Equal(history.Count, restored["messages"]!.AsArray().Count);
                for (var index = 0; index < history.Count; index++)
                {
                    var expected = (JsonObject)history[index].DeepClone();
                    expected.Remove("__meta");
                    expected.Remove("modelVisible");
                    Assert.Equal(LlmRequestJournalStore.EncodeCli(expected),
                        LlmRequestJournalStore.EncodeCli(restored["messages"]![index]!));
                }
                var attempt = restored["attempts"]![0]!;
                Assert.Equal(expectedHash, attempt["start"]!["semanticPayloadSha256"]!.GetValue<string>());
                Assert.Equal($"result-{session}-{iteration}", attempt["result"]!["result"]!["text"]!.GetValue<string>());
            }
        })).ToArray();
        start.Set();
        await Task.WhenAll(callers).WaitAsync(TimeSpan.FromSeconds(30));
        using var connection = new SqliteConnection($"Data Source={journal.FilePath};Pooling=False");
        connection.Open();
        using var objects = connection.CreateCommand();
        objects.CommandText = "SELECT object_id,object_kind,payload FROM llm_journal_objects";
        using var reader = objects.ExecuteReader();
        while (reader.Read())
            Assert.Equal(Digest(reader.GetString(1) + "\0" + reader.GetString(2)), reader.GetString(0));
    }

    [Fact]
    public async Task Cancelled_preparation_does_not_publish_partial_requests_or_attempts()
    {
        using var temp = new TempDirectory();
        using var journal = new LlmRequestJournalStore(temp.Path);
        var id = await journal.BeginRequestAsync("session", "normal-turn", 0, "prompt", [], [], "model", "cache");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => journal.BeginRequestAsync(
            "session", "normal-turn", 1, "prompt", [], [], "model", "cache", cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => journal.AppendAttemptStartAsync(
            id, 1, "model", null, "responses", new JsonObject(), "prompt", cancellation.Token));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => journal.AppendAttemptResultAsync(
            id, 1, "success", new JsonObject(), null, cancellation.Token));
        Assert.Single(await journal.ListAsync("session", null, null, null, 100));
        Assert.Empty((await journal.ReconstructAsync(id))["attempts"]!.AsArray());
    }

    private static string Digest(string text) =>
        "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}
