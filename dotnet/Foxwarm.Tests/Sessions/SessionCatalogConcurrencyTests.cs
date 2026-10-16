using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

public sealed class SessionCatalogConcurrencyTests(ITestOutputHelper output)
{
    [Fact]
    public async Task Ordinary_exact_and_resolution_reads_complete_while_a_presentation_writer_is_held()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([
            SessionCatalogTests.Row("one", 0, aliases: ["only", "shared"]),
            SessionCatalogTests.Row("two", 0, aliases: ["shared"]),
        ]);
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        catalog.BeforePresentationMutation = _ =>
        {
            entered.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("Presentation writer was not released.");
            return null!;
        };
        var writer = Task.Factory.StartNew(() => catalog.Pin("one", true), TaskCreationOptions.LongRunning);
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        var watch = Stopwatch.StartNew();
        var reads = Enumerable.Range(0, 8).Select(_ => Task.Factory.StartNew(() =>
        {
            return new[] { catalog.Get("one")!, catalog.Resolve("one"), catalog.Resolve("only"), catalog.Resolve("shared"), catalog.Resolve("absent") };
        }, TaskCreationOptions.LongRunning)).ToArray();
        try
        {
            var results = await Task.WhenAll(reads).WaitAsync(TimeSpan.FromSeconds(1));
            foreach (var result in results)
            {
                Assert.Null(result[0]["pinned"]);
                Assert.Equal("exact", result[1]["kind"]!.GetValue<string>());
                Assert.Equal("one", result[2]["sessionId"]!.GetValue<string>());
                Assert.Equal("ambiguous", result[3]["kind"]!.GetValue<string>());
                Assert.Equal("missing", result[4]["kind"]!.GetValue<string>());
            }
            output.WriteLine($"Eight ordinary readers completed all 40 Get/Resolve calls in {watch.Elapsed.TotalMilliseconds:F3} ms while the writer remained held.");
            Assert.False(writer.IsCompleted);
        }
        catch (TimeoutException)
        {
            output.WriteLine($"Held writer: {reads.Count(read => read.IsCompleted)} of eight readers completed within {watch.Elapsed.TotalMilliseconds:F3} ms.");
            throw;
        }
        finally
        {
            release.Set();
            await writer;
            await Task.WhenAll(reads);
        }
        Assert.True(catalog.Get("one")!["pinned"]!.GetValue<bool>());
        // Publication reads current Main fields on its writer connection, not an older reader snapshot.
        catalog.PublishAuthority(SessionCatalogTests.Row("one", 10));
        Assert.True(catalog.Get("one")!["pinned"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Children_rows_and_totals_keep_the_existing_writer_exclusion()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Upsert([SessionCatalogTests.Row("parent", 0), SessionCatalogTests.Row("child", 0, "parent")]);
        using var rowsRead = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var writerStarted = new ManualResetEventSlim();
        catalog.QueryObserved = (sql, _) =>
        {
            if (!sql.Contains("INDEXED BY idx_session_catalog_parent_default", StringComparison.Ordinal))
                return;
            rowsRead.Set();
            if (!release.Wait(TimeSpan.FromSeconds(10)))
                throw new TimeoutException("Children query was not released.");
        };
        var query = Task.Factory.StartNew(() => catalog.Children([("parent", null)], "default", 10, null), TaskCreationOptions.LongRunning);
        Assert.True(rowsRead.Wait(TimeSpan.FromSeconds(5)));
        var writer = Task.Factory.StartNew(() =>
        {
            writerStarted.Set();
            catalog.SetParent("child", null);
        }, TaskCreationOptions.LongRunning);
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
        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() => Assert.Null(catalog.Get("parent")))));
        catalog.Upsert([
            SessionCatalogTests.Row("parent", 0, aliases: ["alias"]),
            SessionCatalogTests.Row("child", 0, "alias"),
        ]);
        Assert.Equal("parent", catalog.Presentation("child")!["parentSessionId"]!.GetValue<string>());
        catalog.RewriteIdentity("parent", "renamed", "main", ["parent", "alias"]);
        Assert.Null(catalog.Get("parent"));
        Assert.Equal("renamed", catalog.Resolve("alias")["sessionId"]!.GetValue<string>());
        Assert.Equal("renamed", catalog.Presentation("child")!["parentSessionId"]!.GetValue<string>());
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
