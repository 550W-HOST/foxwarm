using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests.Models;

// Ledger-table removal is file-only; the ledger contract cases are in LlmJournalContractTests.
public sealed class LlmUsageLedgerTests : IDisposable
{
    private readonly string root = Path.Combine(
        Path.GetTempPath(),
        "foxwarm-usage-ledger-" + Guid.NewGuid().ToString("N")
    );

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(root))
            Directory.Delete(root, recursive: true);
    }

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
        LlmRequestJournalStore store,
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
            [
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "hi" }),
                },
            ],
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

    private static long Count(string root, string sql = "SELECT count(*) FROM llm_usage")
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(root, "state", "llm-request-journal.sqlite"),
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar());
    }

    private static void Execute(string root, string sql)
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(root, "state", "llm-request-journal.sqlite"),
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    [Fact]
    public async Task A_removed_or_emptied_ledger_is_rebuilt_and_never_fails_a_result()
    {
        await using var store = new LlmRequestJournalStore(root);
        var failures = 0;
        store.UsageLedgerFailed += () => failures++;
        for (var index = 0; index < 3; index++)
        {
            var id = await StartAsync(store, "s", "normal-turn", "p/m");
            await store.AppendChatResultAsync(id, 1, Result(Usage(0, 1, 1, 0.1)));
        }
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.True(store.UsageCoverage().Complete);

        Execute(root, "DROP TABLE llm_usage");
        Assert.Null(store.UsageCoverage().Earliest);
        Assert.False(store.UsageCoverage().Complete);
        var during = await StartAsync(store, "s", "normal-turn", "p/m");
        await store.AppendChatResultAsync(during, 1, Result(Usage(0, 1, 1, 0.1)));
        Assert.Equal(1, failures);
        Assert.Equal(4, Count(root, "SELECT count(*) FROM llm_journal_attempt_results WHERE outcome='success'"));

        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(4, Count(root));
        Assert.True(store.UsageCoverage().Complete);
        Assert.NotNull(store.UsageCoverage().Earliest);

        Execute(root, "DELETE FROM llm_usage");
        await store.BackfillUsageAsync(CancellationToken.None);
        Assert.Equal(4, Count(root));
        Assert.True(store.UsageCoverage().Complete);
    }
}
