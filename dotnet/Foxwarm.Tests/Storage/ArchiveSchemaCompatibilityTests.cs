using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class ArchiveSchemaCompatibilityTests
{
    private static async Task<JsonObject> Source(string mode, string root, bool retained)
    {
        var repo =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned source fixture root is required.");
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = repo,
                ArgumentList =
                {
                    Path.Combine(repo, "dotnet", "archive-schema-fixture-ts.mjs"),
                    mode,
                    root,
                    retained ? "retained" : "current",
                },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var text = await stdout;
        Assert.True(process.ExitCode == 0, text + await stderr);
        const string prefix = "ARCHIVE_SCHEMA_FIXTURE:";
        return JsonNode
            .Parse(
                text.Split('\n').Single(line => line.StartsWith(prefix, StringComparison.Ordinal))[
                    prefix.Length..
                ]
            )!
            .AsObject();
    }

    private static ArchiveMessageRecord Raw(string owner, long seq, string? text = null) =>
        ArchiveMessageRecord.Create(
            owner,
            "main",
            seq,
            seq * 1000,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text ?? owner + " " + seq }),
                ["__meta"] = new JsonObject { ["seq"] = seq, ["timestamp"] = seq * 1000 },
            }
        );

    private static SqliteConnection Open(string path)
    {
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = SqliteOpenMode.ReadWrite,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        return connection;
    }

    private static string[] OriginalBranches(string path)
    {
        using var connection = Open(path);
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT * FROM archive_branches WHERE session_id IN ('parent','child') ORDER BY session_id";
        using var reader = command.ExecuteReader();
        var rows = new List<string>();
        while (reader.Read())
            rows.Add(
                string.Join("|", Enumerable.Range(0, reader.FieldCount).Select(reader.GetValue))
            );
        return rows.ToArray();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Source_schema_with_retained_branch_extension_preserves_rows_and_current_lineage_through_write_and_reopen(
        bool retained
    )
    {
        using var temp = new TempDirectory();
        var source = await Source("seed", temp.Path, retained);
        var path = Path.Combine(temp.Path, "state", "archive-store.sqlite");
        var originalBranches = OriginalBranches(path);
        var child = new SqliteArchiveMessageStore(path, "child");
        child.Initialize();
        Assert.True(
            JsonNode.DeepEquals(
                source["messages"],
                new JsonArray(
                    child
                        .ReadEffectiveMessagesRange(1, 9)
                        .Select(row => (JsonNode)row.Message.DeepClone())
                        .ToArray()
                )
            )
        );
        // The current Source uses only the message and block-ID caps. A retained raw cap of 1 must not exclude block 2.
        Assert.Equal(
            new long[] { 1, 2 },
            child.ReadEffectiveBlocksRange(1, 9).Select(row => row.Id)
        );
        Assert.Equal(
            new long[] { 1, 2, 3 },
            child.ReadEffectiveMessagesPage(null, null, 100).Select(row => row.Seq)
        );
        var originalMessages = new SqliteArchiveMessageStore(path, "parent")
            .ReadMessages()
            .Select(row => row.MessageJson)
            .ToArray();
        var nested = new SqliteArchiveMessageStore(path, "nested");
        nested.Initialize();
        nested.EnsureBranch("child", 3, 2);
        nested.WriteMessages([Raw("nested", 4)]);
        child.WriteMessages([Raw("child", 4)]);
        Assert.Throws<InvalidDataException>(() =>
            child.WriteMessages([Raw("child", 3, "conflicting immutable payload")])
        );
        Assert.Throws<InvalidDataException>(() => child.EnsureBranch("parent", 1, 2));
        new SqliteArchiveMessageStore(path, "nested").Initialize();
        Assert.Equal(
            new[] { "parent", "parent", "child", "nested" },
            nested.ReadEffectiveMessagesRange(1, 9).Select(row => row.SessionId)
        );
        Assert.Equal(
            originalMessages,
            new SqliteArchiveMessageStore(path, "parent")
                .ReadMessages()
                .Select(row => row.MessageJson)
        );
        Assert.Equal(originalBranches, OriginalBranches(path));
        var reopenedSource = await Source("verify", temp.Path, retained);
        var sourceFork = new SqliteArchiveMessageStore(path, "source-reopen");
        sourceFork.Initialize();
        Assert.True(
            JsonNode.DeepEquals(
                reopenedSource["messages"],
                new JsonArray(
                    sourceFork
                        .ReadEffectiveMessagesRange(1, 9)
                        .Select(row => (JsonNode)row.Message.DeepClone())
                        .ToArray()
                )
            )
        );
        Assert.Equal(originalBranches, OriginalBranches(path));
        using var connection = Open(path);
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA table_info(archive_branches)";
        using (var reader = command.ExecuteReader())
        {
            var columns = new List<string>();
            while (reader.Read())
                columns.Add(reader.GetString(1));
            Assert.Equal(retained, columns.Contains("fork_block_raw_end_seq"));
            Assert.Equal(retained ? 7 : 6, columns.Count);
        }
        if (retained)
        {
            command.CommandText =
                "SELECT fork_block_raw_end_seq FROM archive_branches WHERE session_id='child'";
            Assert.Equal(1L, command.ExecuteScalar());
            command.CommandText =
                "SELECT count(*) FROM archive_branches WHERE session_id<>'child' AND fork_block_raw_end_seq IS NOT NULL";
            Assert.Equal(0L, command.ExecuteScalar());
        }
    }

    [Fact]
    public void Missing_required_branch_column_and_invalid_fork_frontier_still_fail()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "archive.sqlite");
        var store = new SqliteArchiveMessageStore(path, "parent");
        store.Initialize();
        store.EnsureBranch();
        using (var connection = Open(path))
        using (var command = connection.CreateCommand())
        {
            command.CommandText =
                "UPDATE archive_branches SET fork_message_seq=-1 WHERE session_id='parent'";
            command.ExecuteNonQuery();
        }
        Assert.Throws<InvalidDataException>(() => store.ReadBranch());
        using (var connection = Open(path))
        using (var command = connection.CreateCommand())
        {
            command.CommandText = "ALTER TABLE archive_branches DROP COLUMN fork_block_id";
            command.ExecuteNonQuery();
        }
        Assert.Throws<InvalidDataException>(() => store.Initialize());
    }
}
