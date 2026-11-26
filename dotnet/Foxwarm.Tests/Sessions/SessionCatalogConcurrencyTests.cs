using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class SessionCatalogConcurrencyTests(ITestOutputHelper output)
{

    [Fact]
    public async Task Children_rows_and_totals_keep_the_existing_writer_exclusion()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([
            SessionCatalogTests.Row("parent", 0),
            SessionCatalogTests.Row("child", 0, "parent"),
        ]);
        using var rowsRead = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var writerStarted = new ManualResetEventSlim();
        catalog.QueryObserved = (sql, _) =>
        {
            if (
                !sql.Contains(
                    "INDEXED BY idx_session_catalog_parent_activity_default",
                    StringComparison.Ordinal
                )
            )
                return;
            rowsRead.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("Children query was not released.");
        };
        var query = Task.Factory.StartNew(
            () => catalog.Children([("parent", null)], "default", 10, null),
            TaskCreationOptions.LongRunning
        );
        Assert.True(rowsRead.Wait(TimeSpan.FromSeconds(5)));
        var writer = Task.Factory.StartNew(
            () =>
            {
                writerStarted.Set();
                catalog.SetParent("child", null);
            },
            TaskCreationOptions.LongRunning
        );
        Assert.True(writerStarted.Wait(TimeSpan.FromSeconds(5)));
        try
        {
            await Task.Delay(100);
            Assert.False(writer.IsCompleted);
        }
        finally
        {
            release.Set();
        }
        var before = Assert.Single(await query);
        await writer;
        Assert.Single(before.Rows);
        Assert.Equal(1, before.Total);
        var after = Assert.Single(catalog.Children([("parent", null)], "default", 10, null));
        Assert.Empty(after.Rows);
        Assert.Equal(0, after.Total);
    }

    [Fact]
    public async Task Concurrent_first_reads_and_reopen_keep_identity_and_normalized_parent_transitions()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        await Task.WhenAll(
            Enumerable.Range(0, 8).Select(_ => Task.Run(() => Assert.Null(catalog.Get("parent"))))
        );
        catalog.Upsert([
            SessionCatalogTests.Row("parent", 0, aliases: ["alias"]),
            SessionCatalogTests.Row("child", 0, "alias"),
        ]);
        Assert.Equal(
            "parent",
            catalog.Presentation("child")!["parentSessionId"]!.GetValue<string>()
        );
        catalog.RewriteIdentity("parent", "renamed", "main", ["parent", "alias"]);
        Assert.Null(catalog.Get("parent"));
        Assert.Equal("renamed", catalog.Resolve("alias")["sessionId"]!.GetValue<string>());
        Assert.Equal(
            "renamed",
            catalog.Presentation("child")!["parentSessionId"]!.GetValue<string>()
        );
        catalog.Dispose();
        Assert.NotNull(catalog.Get("renamed"));
        catalog.RemoveForDeletion("renamed");
        Assert.Equal("missing", catalog.Resolve("alias")["kind"]!.GetValue<string>());
        Assert.Null(catalog.Presentation("child")!["parentSessionId"]);
        catalog.Dispose();
        Assert.Null(catalog.Get("renamed"));
        Assert.Equal("exact", catalog.Resolve("child")["kind"]!.GetValue<string>());
    }
}
