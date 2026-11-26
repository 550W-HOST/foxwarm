using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Models;

/// <summary>
/// Observable behavior every <see cref="ILlmJournalStore"/> shares: request manifests and
/// their reconstruction, the writer's batching and per-command failures, the usage ledger
/// with its backfill and coverage, and the redaction statistics. Runs on the SQLite journal
/// and on PostgreSQL. File-only behavior (legacy JSONL migration, export, the shared root
/// writer and ledger-table removal) stays in the file test classes.
/// </summary>
public abstract partial class LlmJournalContractTests
{
    private protected abstract Task<Backend> CreateAsync();

    /// <summary>One journal backend under test with what the cases inspect.</summary>
    private protected abstract class Backend : IAsyncDisposable
    {
        /// <summary>A new store over the same data, as after a restart or a takeover.</summary>
        internal abstract ILlmJournalStore Open();

        /// <summary>A scalar query over the journal tables, returned as a number.</summary>
        internal abstract long Count(string sql);

        /// <summary>The expression of the attempt results' insertion order.</summary>
        internal abstract string ResultOrder { get; }

        internal abstract void BeforeBatch(ILlmJournalStore store, Func<Task>? hook);

        internal abstract long CommittedBatches(ILlmJournalStore store);

        internal abstract int LargestBatch(ILlmJournalStore store);

        public abstract ValueTask DisposeAsync();

        internal long Ledger() => Count("SELECT count(*) FROM llm_usage");

        internal string Metadata(string key) =>
            Count($"SELECT CAST(value AS INTEGER) FROM llm_journal_metadata WHERE key='{key}'")
                .ToString(System.Globalization.CultureInfo.InvariantCulture);

        internal string MaxResult() =>
            Count($"SELECT max({ResultOrder}) FROM llm_journal_attempt_results")
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static readonly long[] Everything = [0, long.MaxValue];

    private static IReadOnlyList<JsonObject> History(string text = "hello") =>
        [
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            },
        ];

    private static JsonObject Usage(long cached, long input, long output, double? cost)
    {
        var usage = new JsonObject
        {
            ["cachedTokens"] = cached,
            ["inputTokens"] = input,
            ["outputTokens"] = output,
        };
        if (cost is not null)
            usage["cost"] = cost;
        return usage;
    }

    private static async Task<string> StartAsync(
        ILlmJournalStore store,
        string? session,
        string purpose,
        string model,
        string? virtualKey = null
    )
    {
        var id = await store.BeginRequestAsync(
            session,
            purpose,
            0,
            "System",
            new JsonArray(),
            History("hi"),
            virtualKey ?? model,
            "cache"
        );
        await store.AppendAttemptStartAsync(
            id,
            1,
            model,
            virtualKey,
            "openai-responses",
            new JsonObject { ["input"] = "hi" },
            "System"
        );
        return id;
    }

    private static ChatResult Result(JsonObject? usage) =>
        new(
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "ok" }),
            },
            usage
        );

    // What a version without the ledger leaves behind: the result row only.
    private static Task LegacySuccessAsync(ILlmJournalStore store, string id, JsonObject? usage) =>
        store.AppendAttemptResultAsync(
            id,
            1,
            "success",
            new JsonObject { ["text"] = "ok", ["usage"] = usage },
            null
        );

    [Fact]
    public async Task Stores_deltas_and_reconstructs_attempts_and_prompt_overrides()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
        var messages = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "Hello NBSP\u00a0😀\uD83D" }),
            },
        };
        var first = await store.BeginRequestAsync(
            "session-1",
            "normal-turn",
            0,
            "System",
            new JsonArray(),
            messages,
            "model-a",
            "cache-a"
        );
        await store.AppendAttemptStartAsync(
            first,
            1,
            "model-a",
            null,
            "responses",
            new JsonObject { ["input"] = messages[0] },
            "System"
        );
        await store.AppendAttemptResultAsync(first, 1, "success", new JsonObject { ["text"] = "ok" }, null);
        await store.AppendAttemptStartAsync(
            first,
            2,
            "model-b",
            "virtual-a",
            "responses",
            new JsonObject { ["input"] = messages[0].DeepClone(), ["model"] = "model-b" },
            "Prompt override"
        );
        var later = new List<string>();
        var history = new List<JsonObject>(messages.Select(message => (JsonObject)message.DeepClone()));
        // Enough turns to pass the delta depth limit, so a checkpoint follows deltas.
        for (var turn = 0; turn < 10; turn++)
        {
            history.Add(new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "turn " + turn }),
            });
            later.Add(await store.BeginRequestAsync(
                "session-1",
                "normal-turn",
                turn + 1,
                "System",
                new JsonArray(new JsonObject { ["name"] = "tool" }),
                history,
                "model-a",
                "cache-b"
            ));
        }

        var reconstructed = await store.ReconstructAsync(first);
        Assert.Equal("complete", reconstructed["completeness"]?.GetValue<string>());
        Assert.Equal(
            "Hello NBSP\u00a0😀\uD83D",
            reconstructed["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>()
        );
        var attempts = reconstructed["attempts"]!.AsArray();
        Assert.Equal(2, attempts.Count);
        Assert.Equal("success", attempts[0]!["result"]!["outcome"]!.GetValue<string>());
        Assert.Equal("System", attempts[0]!["systemPrompt"]!.GetValue<string>());
        Assert.Equal("Prompt override", attempts[1]!["systemPrompt"]!.GetValue<string>());
        Assert.Equal("virtual-a", attempts[1]!["start"]!["virtualModelKey"]!.GetValue<string>());
        Assert.Null(attempts[1]!["result"]);
        for (var turn = 0; turn < later.Count; turn++)
        {
            var request = await store.ReconstructAsync(later[turn]);
            Assert.Equal("complete", request["completeness"]?.GetValue<string>());
            Assert.Equal(turn + 2, request["messageCount"]!.GetValue<int>());
            Assert.Equal(
                "turn " + turn,
                request["messages"]![turn + 1]!["parts"]![0]!["text"]!.GetValue<string>()
            );
            Assert.Equal("tool", request["toolDefinitions"]![0]!["name"]!.GetValue<string>());
        }
        Assert.Equal(1, backend.Count("SELECT count(*) FROM llm_journal_requests WHERE delta_depth=0 AND request_id<>'" + first + "'"));
        Assert.Equal(
            "legacy-partial",
            (await store.ReconstructAsync("missing"))["completeness"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Lists_newest_first_with_filters_and_a_keyset_cursor()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
        var ids = new List<string>();
        for (var index = 0; index < 5; index++)
        {
            ids.Add(await store.BeginRequestAsync(
                index % 2 == 0 ? "even" : "odd",
                index < 3 ? "normal-turn" : "btw",
                index,
                "System",
                new JsonArray(),
                History("m" + index),
                "model",
                "cache"
            ));
            await Task.Delay(2);
        }
        var all = await store.ListAsync(null, null, null, null, 10);
        Assert.Equal(ids.AsEnumerable().Reverse(), all.Select(row => row!["requestId"]!.GetValue<string>()));
        var row = all[0]!.AsObject();
        Assert.Equal("even", row["sessionId"]!.GetValue<string>());
        Assert.Equal("btw", row["purpose"]!.GetValue<string>());
        Assert.Equal(4, row["iteration"]!.GetValue<int>());
        Assert.Equal(1, row["messageCount"]!.GetValue<int>());
        Assert.Equal("model", row["requestedModelKey"]!.GetValue<string>());
        Assert.Equal(
            [ids[4], ids[2], ids[0]],
            (await store.ListAsync("even", null, null, null, 10)).Select(item => item!["requestId"]!.GetValue<string>())
        );
        Assert.Equal(
            [ids[2], ids[0]],
            (await store.ListAsync("even", "normal-turn", null, null, 10)).Select(item => item!["requestId"]!.GetValue<string>())
        );
        var page = await store.ListAsync(null, null, null, null, 2);
        var next = await store.ListAsync(
            null,
            null,
            page[1]!["createdAt"]!.GetValue<long>(),
            page[1]!["requestId"]!.GetValue<string>(),
            2
        );
        Assert.Equal([ids[2], ids[1]], next.Select(item => item!["requestId"]!.GetValue<string>()));
    }

    [Fact]
    public async Task Attempts_require_their_request_and_start_and_the_first_attempt_uses_the_request_prompt()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            store.AppendAttemptStartAsync("missing", 1, "m", null, "t", new JsonObject(), "System")
        );
        var id = await store.BeginRequestAsync("s", "test", 0, "System", new JsonArray(), History(), "m", "c");
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            store.AppendAttemptStartAsync(id, 1, "m", null, "t", new JsonObject(), "Other")
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            store.AppendAttemptResultAsync(id, 1, "success", new JsonObject(), null)
        );
        await store.AppendAttemptStartAsync(id, 1, "m", null, "t", new JsonObject(), "System");
        await store.AppendAttemptResultAsync(id, 1, "failure", null, new JsonObject { ["message"] = "x" });
        var restored = await store.ReconstructAsync(id);
        Assert.Equal("failure", restored["attempts"]![0]!["result"]!["outcome"]!.GetValue<string>());
        // A second result for the same attempt makes the request inconsistent.
        await store.AppendAttemptResultAsync(id, 1, "failure", null, new JsonObject { ["message"] = "y" });
        Assert.Equal("corrupt", (await store.ReconstructAsync(id))["completeness"]!.GetValue<string>());
    }

    [Fact]
    public async Task Identical_objects_are_stored_once()
    {
        await using var backend = await CreateAsync();
        await using var store = backend.Open();
        for (var index = 0; index < 3; index++)
            await store.BeginRequestAsync(null, "test", 0, "System", new JsonArray(), History(), "m", "c");
        // One prompt, one tool schema and one message, whatever the number of requests.
        Assert.Equal(3, backend.Count("SELECT count(*) FROM llm_journal_objects"));
        Assert.Equal(3, backend.Count("SELECT count(*) FROM llm_journal_requests"));
    }
}
