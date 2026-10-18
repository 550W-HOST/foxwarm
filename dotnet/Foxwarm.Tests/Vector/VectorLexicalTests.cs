using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorLexicalTests
{
    [Fact]
    public void Fts_documents_and_checkpoint_roll_back_together_and_reopen_with_the_Source_schema()
    {
        using var temp = new TempDirectory();
        var path = Path.Combine(temp.Path, "fts.sqlite");
        using (var index = ArchiveSearchIndex.Open(path))
        {
            var row = new JsonObject
            {
                ["session_id"] = "main/fts",
                ["agent"] = "main",
                ["memory_kind"] = "raw",
                ["source_key"] = "1",
                ["source_family"] = "main/fts:raw:1-1",
                ["seq"] = 1,
                ["text"] = "FooBar 中文组合测试",
            };
            index.BeforeCheckpointWrite = () =>
                throw new IOException("synthetic checkpoint failure");
            Assert.Throws<IOException>(() => index.Raw("main/fts", [row], 1));
            Assert.Equal(0, index.Checkpoint("main/fts").RawLastIndexedSeq);
            Assert.Empty(index.Query("FooBar", new(SessionIds: ["main/fts"]), 10));
            index.BeforeCheckpointWrite = null;
            index.Raw("main/fts", [row], 1);
            Assert.Single(index.Query("FooBar", new(SessionIds: ["main/fts"]), 10));
            Assert.Single(index.Query("中文组合", new(SessionIds: ["main/fts"]), 10));
            Assert.Empty(index.Query("FooBar", new(SessionIds: ["main/other"]), 10));
            Assert.Empty(index.Query("FooBar", new(LineageSessions: [new("main/fts", 0, 0)]), 10));
            index.Raw("main/fts", [row], 1);
            Assert.Single(index.Query("FooBar", null, 10));
        }
        using var reopened = ArchiveSearchIndex.Open(path);
        Assert.Equal(1, reopened.Checkpoint("main/fts").RawLastIndexedSeq);
        Assert.Single(reopened.Query("中文组合", null, 10));
    }

    [Fact]
    public async Task Dense_token_threshold_does_not_force_lexical_progress_and_the_non_sliding_lexical_deadline_flushes()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/deadline";
        f.Append(id, 1, "FooBar initial violet");
        var clock = new ManualWsClock();
        await using var runtime = new VectorRuntime(f.Data, f.Configuration(lexical: true), clock);
        await runtime.StartAsync();
        await runtime.WaitForStartupAsync();
        f.Append(id, 2, "FooBar second violet");
        runtime.Schedule(id, 2, 8000, 0);
        await VectorStorageTests.UntilAsync(() =>
            f.Archive(id).VectorCheckpoint().RawLastIndexedSeq == 2
        );
        Assert.Equal(1, VectorRuntime.Integer(runtime.Lexical.Status(id)["rawLastIndexedSeq"]));
        var deadline = VectorRuntime.Integer(runtime.Lexical.Status(id)["maxLatencyDeadline"]);
        clock.Advance(TimeSpan.FromMinutes(2));
        f.Append(id, 3, "FooBar third violet");
        runtime.Schedule(id, 3, 5, 0);
        Assert.Equal(
            deadline,
            VectorRuntime.Integer(runtime.Lexical.Status(id)["maxLatencyDeadline"])
        );
        clock.Advance(TimeSpan.FromMinutes(3));
        await runtime.Lexical.WaitForIdleAsync();
        Assert.Equal(3, VectorRuntime.Integer(runtime.Lexical.Status(id)["rawLastIndexedSeq"]));
        Assert.Equal(2, f.Archive(id).VectorCheckpoint().RawLastIndexedSeq);
        clock.Advance(TimeSpan.FromMinutes(2));
        await VectorStorageTests.UntilAsync(() =>
            f.Archive(id).VectorCheckpoint().RawLastIndexedSeq == 3
        );
        var query = await runtime.Lexical.QueryAsync("FooBar", 5, new(SessionIds: [id]));
        Assert.NotEmpty(query.Hits);
        Assert.True(query.Lexical["coverageComplete"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Exact_coverage_rechecks_authority_both_before_and_after_the_FTS_query()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/coverage";
        f.Append(id, 1, "FooBar indexed source");
        await using var lexical = new VectorLexicalRuntime(
            f.Dense,
            f.Database,
            f.Configuration(lexical: true),
            TimeProvider.System
        );
        await lexical.StartAsync();
        await lexical.WaitForStartupAsync();
        var first = await lexical.QueryAsync("FooBar", 5, new(SessionIds: [id]));
        Assert.True(first.Lexical["coverageComplete"]!.GetValue<bool>());
        lexical.AfterCoveragePre = () =>
        {
            f.Append(id, 2, "FooBar committed during query");
            return Task.CompletedTask;
        };
        var concurrent = await lexical.QueryAsync("FooBar", 5, new(SessionIds: [id]));
        Assert.NotEmpty(concurrent.Hits);
        Assert.False(concurrent.Lexical["coverageComplete"]!.GetValue<bool>());
        lexical.AfterCoveragePre = null;
        lexical.Force(id, 2, 0);
        await lexical.WaitForIdleAsync();
        lexical.AfterFtsQuery = () =>
        {
            f.Append(id, 3, "FooBar committed after FTS query");
            return Task.CompletedTask;
        };
        Assert.False(
            (await lexical.QueryAsync("FooBar", 5, new(SessionIds: [id]))).Lexical[
                "coverageComplete"
            ]!.GetValue<bool>()
        );
        Assert.False(
            (await lexical.QueryAsync("FooBar", 5, new(SessionIds: ["main/missing"]))).Lexical[
                "coverageComplete"
            ]!.GetValue<bool>()
        );
    }

    [Fact]
    public async Task Interrupted_shadow_promotion_restores_the_previous_file_and_resumes_from_next_on_restart()
    {
        await using var f = await VectorFixture.CreateAsync();
        const string id = "main/shadow";
        f.Append(id, 1, "FooBar durable archive");
        var path = Path.Combine(f.Dense, "archive-search.sqlite");
        await using (
            var original = new VectorLexicalRuntime(
                f.Dense,
                f.Database,
                f.Configuration(lexical: true),
                TimeProvider.System
            )
        )
        {
            await original.StartAsync();
            await original.WaitForStartupAsync();
        }
        using (
            var db = new SqliteConnection(
                new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()
            )
        )
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "UPDATE archive_search_metadata SET value='0' WHERE key='schema_version'";
            command.ExecuteNonQuery();
        }
        await using (
            var failed = new VectorLexicalRuntime(
                f.Dense,
                f.Database,
                f.Configuration(lexical: true),
                TimeProvider.System
            )
        )
        {
            failed.BeforePromotionValidation = () =>
                throw new IOException("synthetic promotion failure");
            await failed.StartAsync();
            await failed.WaitForStartupAsync();
            Assert.False(failed.Status(id)["ready"]!.GetValue<bool>());
            Assert.Equal(
                "LEXICAL_REBUILD_PROMOTION_FAILED",
                failed.Status(id)["lastErrorCode"]!.GetValue<string>()
            );
            Assert.True(File.Exists(path));
            Assert.True(File.Exists(path + ".next"));
        }
        await using var resumed = new VectorLexicalRuntime(
            f.Dense,
            f.Database,
            f.Configuration(lexical: true),
            TimeProvider.System
        );
        await resumed.StartAsync();
        await resumed.WaitForStartupAsync();
        Assert.True(resumed.Status(id)["ready"]!.GetValue<bool>());
        Assert.Single((await resumed.QueryAsync("FooBar", 5, new(SessionIds: [id]))).Hits);
        Assert.False(File.Exists(path + ".next"));
        Assert.False(File.Exists(path + ".bak"));
    }

    [Fact]
    public async Task Shadow_rebuild_checks_actual_space_without_destroying_the_old_database()
    {
        await using var f = await VectorFixture.CreateAsync();
        f.Append("main/space", 1, "FooBar source");
        var path = Path.Combine(f.Dense, "archive-search.sqlite");
        using (var created = ArchiveSearchIndex.Open(path)) { }
        using (
            var db = new SqliteConnection(
                new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString()
            )
        )
        {
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "UPDATE archive_search_metadata SET value='0' WHERE key='schema_version'";
            command.ExecuteNonQuery();
        }
        await using var lexical = new VectorLexicalRuntime(
            f.Dense,
            f.Database,
            f.Configuration(lexical: true),
            TimeProvider.System
        )
        {
            FreeBytes = () => 0,
        };
        await lexical.StartAsync();
        await lexical.WaitForStartupAsync();
        Assert.Equal(
            "LEXICAL_REBUILD_SPACE",
            lexical.Status("main/space")["lastErrorCode"]!.GetValue<string>()
        );
        Assert.False(File.Exists(path + ".next"));
        Assert.True(File.Exists(path));
    }
}
