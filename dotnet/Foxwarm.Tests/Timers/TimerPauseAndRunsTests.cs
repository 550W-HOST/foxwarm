using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Timers;

namespace Foxwarm.Tests;

public sealed class TimerPauseAndRunsTests
{
    private static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static JsonObject Message(
        string owner = "owner",
        string? cron = null,
        double? at = null
    ) =>
        new()
        {
            ["sessionId"] = owner,
            ["message"] = "hello",
            ["createdAt"] = 1,
            ["newSession"] = false,
            ["cron"] = cron,
            ["at"] = at,
        };

    private static JsonObject Script(string? cron = null) =>
        new()
        {
            ["sessionId"] = "owner",
            ["message"] = "",
            ["action"] = "toolscript",
            ["script"] = new JsonObject { ["code"] = "return 1" },
            ["createdAt"] = 1,
            ["cron"] = cron,
        };

    private static JsonArray Rows(string root) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(root, "state", "timers.json")))![
            "timers"
        ]!.AsArray();

    private static async Task Seed(string root, params JsonObject[] rows)
    {
        Directory.CreateDirectory(Path.Combine(root, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(root, "state", "timers.json"),
            new JsonObject
            {
                ["timers"] = new JsonArray(rows.Select(row => (JsonNode?)row).ToArray()),
            }.ToJsonString()
        );
    }

    private static async Task Until(Func<bool> ready, int seconds = 6)
    {
        var end = DateTime.UtcNow.AddSeconds(seconds);
        while (!ready() && DateTime.UtcNow < end)
            await Task.Delay(10);
        Assert.True(ready());
    }

    private static async Task<JsonObject> Update(MainTimers timers, string id, JsonObject args)
    {
        var existing = timers.Get(id, "owner");
        var row = MainTimers.UpdateRow(existing, args, new JsonObject { ["agent"] = "main" });
        return await timers.UpdateAsync(id, row, default);
    }

    [Fact]
    public async Task Paused_cron_keeps_its_schedule_survives_reload_and_resumes_without_replay()
    {
        using var temp = new TempDirectory();
        var count = 0;
        string id;
        await using (
            var timers = new MainTimers(
                temp.Path,
                _ =>
                {
                    Interlocked.Increment(ref count);
                    return Task.CompletedTask;
                }
            )
            {
                Diagnostic = (_, _) => { },
            }
        )
        {
            await timers.LoadAsync();
            timers.Start();
            var created = await timers.CreateAsync(Message(cron: "* * * * * *"), default);
            id = SessionWait.Text(created["id"])!;
            await Until(() => Volatile.Read(ref count) >= 1, 4);
            var paused = await Update(timers, id, new JsonObject { ["paused"] = true });
            Assert.True(paused["paused"]!.GetValue<bool>());
            Assert.Null(paused["nextRunAt"]);
            Assert.Equal("* * * * * *", SessionWait.Text(paused["cron"]));
            var atPause = Volatile.Read(ref count);
            await Task.Delay(2300);
            Assert.Equal(atPause, Volatile.Read(ref count));
            var listed = Assert.Single(timers.List("owner"))!.AsObject();
            Assert.True(listed["paused"]!.GetValue<bool>());
            Assert.Null(listed["nextRunAt"]);
        }
        Assert.True(Rows(temp.Path).Single()!["paused"]!.GetValue<bool>());

        var resumed = 0;
        await using var reloaded = new MainTimers(
            temp.Path,
            _ =>
            {
                Interlocked.Increment(ref resumed);
                return Task.CompletedTask;
            }
        )
        {
            Diagnostic = (_, _) => { },
        };
        await reloaded.LoadAsync();
        reloaded.Start();
        await Task.Delay(1300);
        Assert.Equal(0, Volatile.Read(ref resumed));
        var row = await Update(reloaded, id, new JsonObject { ["paused"] = false });
        Assert.False(row["paused"]!.GetValue<bool>());
        Assert.NotNull(row["nextRunAt"]);
        Assert.False(Rows(temp.Path).Single()!.AsObject().ContainsKey("paused"));
        await Until(() => Volatile.Read(ref resumed) >= 1, 4);
        // Missed ticks while paused are not replayed: one tick per second at most.
        await Task.Delay(1000);
        Assert.InRange(Volatile.Read(ref resumed), 1, 3);
    }

    [Fact]
    public async Task Paused_overdue_one_time_timer_fires_once_on_resume()
    {
        using var temp = new TempDirectory();
        var paused = Message(at: Now - 60_000);
        paused["id"] = "overdue";
        paused["paused"] = true;
        await Seed(temp.Path, paused);
        var count = 0;
        await using var timers = new MainTimers(
            temp.Path,
            _ =>
            {
                Interlocked.Increment(ref count);
                return Task.CompletedTask;
            }
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        await Task.Delay(300);
        Assert.Equal(0, count);
        Assert.Single(timers.List("owner"));
        await Update(timers, "overdue", new JsonObject { ["paused"] = false });
        await Until(() => Rows(temp.Path).Count == 0);
        Assert.Equal(1, count);
    }

    [Theory]
    [InlineData("\"yes\"")]
    [InlineData("1")]
    [InlineData("null")]
    public void Paused_must_be_a_boolean(string value)
    {
        var args = new JsonObject { ["paused"] = JsonNode.Parse(value) };
        var error = Assert.Throws<InvalidDataException>(() =>
            MainTimers.UpdateRow(Message(cron: "0 0 * * *"), args, new JsonObject())
        );
        Assert.Contains("paused", error.Message);
    }

    [Fact]
    public void Update_keeps_pause_and_results_and_still_requires_exactly_one_schedule()
    {
        var existing = Message(cron: "0 0 * * *");
        existing["paused"] = true;
        existing["recentRuns"] = new JsonArray(
            new JsonObject { ["at"] = 5, ["outcome"] = "delivered" }
        );
        var owner = new JsonObject { ["agent"] = "main" };
        var updated = MainTimers.UpdateRow(
            existing,
            new JsonObject { ["message"] = "changed" },
            owner
        );
        Assert.True(updated["paused"]!.GetValue<bool>());
        Assert.Equal("changed", SessionWait.Text(updated["message"]));
        Assert.Single(updated["recentRuns"]!.AsArray());
        Assert.ThrowsAny<Exception>(() =>
            MainTimers.UpdateRow(
                existing,
                new JsonObject { ["cron"] = "0 0 * * *", ["afterSeconds"] = 5 },
                owner
            )
        );
        Assert.ThrowsAny<Exception>(() =>
            MainTimers.UpdateRow(existing, new JsonObject { ["cron"] = "not cron" }, owner)
        );
        Assert.Throws<InvalidDataException>(() =>
            MainTimers.UpdateRow(existing, new JsonObject(), owner)
        );
    }

    [Fact]
    public async Task Run_results_are_bounded_newest_first_and_old_rows_read_without_them()
    {
        using var temp = new TempDirectory();
        var full = Message(cron: "* * * * * *");
        full["id"] = "full";
        full["recentRuns"] = new JsonArray(
            Enumerable
                .Range(0, MainTimers.RecentRunLimit)
                .Select(index =>
                    (JsonNode?)new JsonObject { ["at"] = 1000 - index, ["outcome"] = "delivered" }
                )
                .ToArray()
        );
        var old = Message("other", cron: "* * * * * *");
        old["id"] = "old";
        var malformed = Message("third", cron: "0 0 1 1 *");
        malformed["id"] = "malformed";
        malformed["recentRuns"] = "unexpected";
        await Seed(temp.Path, full, old, malformed);
        await using var timers = new MainTimers(
            temp.Path,
            row =>
                SessionWait.Text(row["id"]) == "full"
                    ? throw new IOException("target unavailable")
                    : Task.CompletedTask
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        // Old and malformed rows read as having no results; nothing is rewritten on load.
        Assert.Empty(timers.ListAll(owner => owner == "other").Single()!["recentRuns"]!.AsArray());
        Assert.Empty(timers.ListAll(owner => owner == "third").Single()!["recentRuns"]!.AsArray());
        Assert.Equal("unexpected", SessionWait.Text(Rows(temp.Path)[2]!["recentRuns"]));
        timers.Start();
        Dictionary<string, JsonObject> rows = [];
        await Until(() =>
        {
            rows = Rows(temp.Path)
                .OfType<JsonObject>()
                .ToDictionary(row => SessionWait.Text(row["id"])!);
            return rows["full"]["recentRuns"]?[0]?["outcome"]?.ToString() == "failed"
                && rows["old"]["recentRuns"] is JsonArray { Count: > 0 };
        });
        var fullRuns = rows["full"]["recentRuns"]!.AsArray();
        Assert.Equal(MainTimers.RecentRunLimit, fullRuns.Count);
        Assert.Equal("failed", SessionWait.Text(fullRuns[0]!["outcome"]));
        Assert.Equal("target unavailable", SessionWait.Text(fullRuns[0]!["error"]));
        Assert.True(SessionWait.Number(fullRuns[0]!["at"]) > 1000);
        // New failures come first; the oldest seeded entries dropped off the end. A slow
        // poll can observe more than one new failure, so count them rather than assume one.
        var added = fullRuns.TakeWhile(run => SessionWait.Number(run!["at"]) > 1000).Count();
        Assert.InRange(added, 1, MainTimers.RecentRunLimit - 1);
        Assert.All(
            fullRuns.Take(added),
            run => Assert.Equal("failed", SessionWait.Text(run!["outcome"]))
        );
        Assert.Equal(
            Enumerable.Range(0, MainTimers.RecentRunLimit - added).Select(index => 1000.0 - index),
            fullRuns.Skip(added).Select(run => SessionWait.Number(run!["at"])!.Value)
        );
        // A failed message delivery records its result but not a trigger time.
        Assert.Null(rows["full"]["lastTriggeredAt"]);
        Assert.Equal("delivered", SessionWait.Text(rows["old"]["recentRuns"]![0]!["outcome"]));
        Assert.NotNull(rows["old"]["lastTriggeredAt"]);
        // Tool results show the latest run only.
        var tool = timers.List("other").Single()!.AsObject();
        Assert.False(tool.ContainsKey("recentRuns"));
        Assert.Equal("delivered", SessionWait.Text(tool["lastRun"]!["outcome"]));
        Assert.False(tool["paused"]!.GetValue<bool>());
    }

    [Theory]
    [InlineData("completed", "completed", null)]
    [InlineData("waiting", "paused", null)]
    [InlineData("failed", "failed", "script error")]
    [InlineData("cancelled", "failed", null)]
    public async Task Script_run_outcome_and_run_id_are_recorded(
        string status,
        string outcome,
        string? error
    )
    {
        using var temp = new TempDirectory();
        var fired = 0;
        await using var timers = MainTimers.Reporting(
            temp.Path,
            _ =>
            {
                Interlocked.Increment(ref fired);
                var result = new JsonObject { ["status"] = status, ["runId"] = "tsr_fixture" };
                if (error is not null)
                    result["error"] = error;
                return Task.FromResult<JsonObject?>(result);
            }
        );
        timers.Diagnostic = (_, _) => { };
        await timers.LoadAsync();
        timers.Start();
        await timers.CreateAsync(Script("* * * * * *"), default);
        await Until(() => Rows(temp.Path).Single()!["recentRuns"] is JsonArray { Count: > 0 });
        var run = Rows(temp.Path).Single()!["recentRuns"]![0]!.AsObject();
        Assert.Equal(outcome, SessionWait.Text(run["outcome"]));
        Assert.Equal("tsr_fixture", SessionWait.Text(run["runId"]));
        Assert.Equal(error, SessionWait.Text(run["error"]));
    }

    [Fact]
    public async Task Overlapping_script_tick_is_recorded_as_skipped()
    {
        using var temp = new TempDirectory();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var timers = new MainTimers(temp.Path, _ => release.Task)
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        await timers.CreateAsync(Script("* * * * * *"), default);
        try
        {
            await Until(() =>
                Rows(temp.Path).Single()!["recentRuns"] is JsonArray runs
                && runs.Any(run => SessionWait.Text(run!["outcome"]) == "skipped")
            );
        }
        finally
        {
            release.TrySetResult();
        }
        await Until(() =>
            Rows(temp.Path).Single()!["recentRuns"]![0] is JsonObject latest
            && SessionWait.Text(latest["outcome"]) == "completed"
        );
    }

    [Fact]
    public async Task ListAll_filters_by_owner_and_excludes_internal_wait_timers()
    {
        using var temp = new TempDirectory();
        var a = Message("main/a", cron: "0 0 1 1 *");
        a["id"] = "a";
        var b = Message("research/b", cron: "0 0 1 1 *");
        b["id"] = "b";
        var wait = Message("main/a", at: Now + 600_000);
        wait["id"] = "wait";
        wait["waitTimeoutId"] = "w";
        wait["waitTimeoutSeconds"] = 30;
        await Seed(temp.Path, a, b, wait);
        await using var timers = new MainTimers(temp.Path, _ => Task.CompletedTask)
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        Assert.Equal(
            ["a", "b"],
            timers.ListAll(_ => true).Select(row => SessionWait.Text(row!["id"])).Order()
        );
        Assert.Equal(
            ["b"],
            timers
                .ListAll(owner => owner == "research/b")
                .Select(row => SessionWait.Text(row!["id"]))
        );
        Assert.Throws<InvalidDataException>(() => timers.Detail("a", "research/b"));
        Assert.Throws<InvalidDataException>(() => timers.Detail("wait", "main/a"));
    }
}
