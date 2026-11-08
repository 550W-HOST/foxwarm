using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

// Sidebar ordering by subtree activity and the recent-activity initial child window,
// through the real list queries over a catalog-only Session manager.
public sealed class SessionListActivityTests
{
    private const long Hour = 3_600_000;
    private const long Now = 1_000 * Hour;

    private static string[] Ids(JsonObject page, string key = "sessions") =>
        page[key]!.AsArray().Select(row => row!["id"]!.GetValue<string>()).ToArray();

    private static async Task<(SessionManager Manager, SessionListQueries View)> OpenAsync(
        TempDirectory temp,
        IEnumerable<JsonObject> rows
    )
    {
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a/wire",
            "",
            "",
            713
        );
        var manager = new SessionManager(data, work, options, HostModels.ForTest(options));
        await manager.LoadAsync();
        manager.Catalog.Upsert(rows);
        return (manager, new SessionListQueries(new SessionRuntime(manager), () => Now));
    }

    private static JsonObject Row(string id, long time, string? parent = null)
    {
        var row = SessionCatalogTests.Row(id, 0, parent);
        row["meta"]!["lastMessageTime"] = time;
        return row;
    }

    private static string[] AllPages(
        Func<string?, JsonObject> read,
        Func<JsonObject, string?> cursor,
        Func<JsonObject, string[]> ids
    )
    {
        var result = new List<string>();
        string? next = null;
        do
        {
            var page = read(next);
            result.AddRange(ids(page));
            next = cursor(page);
        } while (next is not null);
        return result.ToArray();
    }

    [Fact]
    public async Task A_quiet_parent_with_an_active_descendant_sorts_by_that_activity_in_tree_modes()
    {
        using var temp = new TempDirectory();
        var (manager, view) = await OpenAsync(
            temp,
            [
                Row("ordered", 1 * Hour),
                Row("quiet", 10 * Hour),
                Row("quiet/mid", 20 * Hour, "quiet"),
                Row("quiet/mid/hot", 900 * Hour, "quiet/mid"),
                Row("busy-alone", 500 * Hour),
                Row("stale", 2 * Hour),
                Row("tail", 3 * Hour),
            ]
        );
        await using var _ = manager;
        var ordered = manager.Catalog.Get("ordered")!;
        ordered["sidebarOrder"] = 1;
        manager.Catalog.Upsert([ordered]);

        Assert.Equal(
            ["quiet", "busy-alone", "tail", "stale", "ordered"],
            Ids(view.Page("time", 10))
        );
        // A saved sidebarOrder still wins; unordered rows follow by activity.
        Assert.Equal(
            ["ordered", "quiet", "busy-alone", "tail", "stale"],
            Ids(view.Page("default", 10))
        );
        // Flat keeps each Session's own time.
        Assert.Equal(
            ["quiet/mid/hot", "busy-alone", "quiet/mid", "quiet", "tail", "stale", "ordered"],
            Ids(view.Page("flat-time", 10))
        );
        // The displayed own time of the quiet parent is unchanged.
        var quiet = view.Page("time", 10)["sessions"]!.AsArray()[0]!;
        Assert.Equal(10 * Hour, SessionCatalog.Number(quiet["lastMessageTime"]));
        Assert.Equal(900 * Hour, SessionCatalog.Number(quiet["subtreeActivityTime"]));

        // Keyset continuation reaches the same order without repeats or gaps.
        foreach (var mode in new[] { "time", "default", "flat-time" })
            Assert.Equal(
                Ids(view.Page(mode, 10)),
                AllPages(
                    cursor => view.Page(mode, 2, cursor),
                    page => page["nextCursor"]?.GetValue<string>(),
                    page => Ids(page)
                )
            );
    }

    [Fact]
    public async Task Child_pages_and_their_continuations_order_children_by_descendant_activity()
    {
        using var temp = new TempDirectory();
        var (manager, view) = await OpenAsync(
            temp,
            [
                Row("p", 1 * Hour),
                Row("p/newer", 300 * Hour, "p"),
                Row("p/quiet", 10 * Hour, "p"),
                Row("p/quiet/hot", 700 * Hour, "p/quiet"),
                Row("p/a", 200 * Hour, "p"),
                Row("p/b", 100 * Hour, "p"),
                Row("p/c", 50 * Hour, "p"),
            ]
        );
        await using var _ = manager;
        foreach (var mode in new[] { "time", "default" })
        {
            var expected = new[] { "p/quiet", "p/newer", "p/a", "p/b", "p/c" };
            Assert.Equal(expected, Ids(view.ChildPages([("p", null)], mode, 10)[0]));
            Assert.Equal(
                expected,
                AllPages(
                    cursor => view.ChildPages([("p", cursor)], mode, 2)[0],
                    page => page["nextCursor"]?.GetValue<string>(),
                    page => Ids(page)
                )
            );
        }
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 1)]
    [InlineData(3, 3)]
    [InlineData(7, 5)]
    public async Task The_initial_child_window_is_the_recent_child_count_clamped_to_one_through_five(
        int recent,
        int expected
    )
    {
        using var temp = new TempDirectory();
        var rows = new List<JsonObject> { Row("p", 1 * Hour) };
        for (var index = 0; index < recent; index++)
            rows.Add(Row("p/recent" + index, Now - (index + 1) * Hour, "p"));
        for (var index = 0; index < 4; index++)
            rows.Add(Row("p/old" + index, Now - (30 + index) * Hour, "p"));
        var (manager, view) = await OpenAsync(temp, rows);
        await using var _ = manager;
        var window = new HashSet<string>(StringComparer.Ordinal) { "p" };
        var page = view.ChildPages([("p", null)], "time", 5, previews: true, recentWindow: window)[0];
        Assert.Equal(expected, Ids(page).Length);
        Assert.Equal(recent + 4, SessionCatalog.Number(page["total"]));
        Assert.Equal(
            Enumerable.Range(0, Math.Min(recent, 5)).Select(index => "p/recent" + index),
            Ids(page).Take(Math.Min(recent, 5))
        );
        // The same request without a window keeps the fixed limit.
        Assert.Equal(
            Math.Min(5, recent + 4),
            Ids(view.ChildPages([("p", null)], "time", 5)[0]).Length
        );
    }

    [Fact]
    public async Task The_recent_window_counts_descendant_activity_and_skips_pinned_archived_and_old_children()
    {
        using var temp = new TempDirectory();
        var archived = Row("p/archived", Now - Hour, "p");
        archived["archived"] = true;
        var pinned = Row("p/pinned", Now - Hour, "p");
        pinned["pinned"] = true;
        var (manager, view) = await OpenAsync(
            temp,
            [
                Row("p", 1 * Hour),
                // Own time is old; a grandchild is recent, so the child is active.
                Row("p/quiet", 10 * Hour, "p"),
                Row("p/quiet/hot", Now - 2 * Hour, "p/quiet"),
                Row("p/edge-in", Now - 24 * Hour, "p"),
                Row("p/edge-out", Now - 24 * Hour - 1, "p"),
                archived,
                pinned,
                Row("p/old", 5 * Hour, "p"),
            ]
        );
        await using var _ = manager;
        var window = new HashSet<string>(StringComparer.Ordinal) { "p" };
        var page = view.ChildPages([("p", null)], "time", 5, previews: true, recentWindow: window)[0];
        Assert.Equal(["p/quiet", "p/edge-in"], Ids(page).Take(2));
        Assert.Equal(2, Ids(page).Length);
    }

    [Fact]
    public async Task A_window_is_only_the_first_page_and_its_continuation_uses_the_normal_page_size()
    {
        using var temp = new TempDirectory();
        var rows = new List<JsonObject> { Row("p", 1 * Hour), Row("q", 1 * Hour) };
        for (var index = 0; index < 12; index++)
            rows.Add(Row("p/c" + index, Now - (index + 1) * Hour, "p"));
        rows.Add(Row("q/c", Now - Hour, "q"));
        var (manager, view) = await OpenAsync(temp, rows);
        await using var _ = manager;
        var window = new HashSet<string>(StringComparer.Ordinal) { "p", "q" };
        var first = view.ChildPages(
            [("p", null), ("q", null)],
            "time",
            5,
            recentWindow: window
        );
        Assert.Equal(5, Ids(first[0]).Length);
        Assert.Equal(["q/c"], Ids(first[1]));
        Assert.NotNull(first[0]["nextCursor"]);
        Assert.Null(first[1]["nextCursor"]);
        // A cursor request is not windowed even when flagged: it returns the full limit.
        var next = view.ChildPages(
            [("p", first[0]["nextCursor"]!.GetValue<string>())],
            "time",
            4,
            recentWindow: window
        )[0];
        Assert.Equal(["p/c5", "p/c6", "p/c7", "p/c8"], Ids(next));
        // Architecture scope never uses the window.
        Assert.Equal(
            5,
            Ids(view.ChildPages([("p", null)], "time", 5, "main", recentWindow: window)[0]).Length
        );
    }

    [Fact]
    public async Task Agent_group_pages_order_members_by_activity_in_tree_modes_and_by_own_time_in_flat()
    {
        using var temp = new TempDirectory();
        var (manager, view) = await OpenAsync(
            temp,
            [
                Row("quiet", 10 * Hour),
                Row("quiet/hot", 800 * Hour, "quiet"),
                Row("busy", 400 * Hour),
            ]
        );
        await using var _ = manager;
        Assert.Equal(
            ["quiet", "busy"],
            Ids(view.GroupPages([("main", null)], "agent", "time", 10)["groups"]![0]!.AsObject())
        );
        Assert.Equal(
            ["quiet/hot", "busy", "quiet"],
            Ids(
                view.GroupPages([("main", null)], "agent", "flat-time", 10)["groups"]![0]!.AsObject()
            )
        );
        // Group continuation under activity order.
        Assert.Equal(
            ["quiet", "busy"],
            AllPages(
                cursor =>
                    view.GroupPages([("main", cursor)], "agent", "time", 1)["groups"]![0]!
                        .AsObject(),
                group => group["nextCursor"]?.GetValue<string>(),
                group => Ids(group)
            )
        );
    }
}
