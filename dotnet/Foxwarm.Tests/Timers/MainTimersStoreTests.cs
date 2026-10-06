using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Timers;

namespace Foxwarm.Tests;

public sealed class MainTimersStoreTests
{
    private static JsonObject Row(string id, double at, string message = "payload") =>
        new()
        {
            ["id"] = id,
            ["sessionId"] = "owner",
            ["message"] = message,
            ["createdAt"] = 1,
            ["at"] = at,
            ["newSession"] = false,
        };

    private static async Task Save(string root, JsonObject document)
    {
        Directory.CreateDirectory(Path.Combine(root, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(root, "state", "timers.json"),
            document.ToJsonString()
        );
    }

    private static JsonArray Rows(string root) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(root, "state", "timers.json")))![
            "timers"
        ]!.AsArray();

    private static async Task WaitUntil(Func<bool> predicate)
    {
        var end = DateTime.UtcNow.AddSeconds(5);
        while (!predicate() && DateTime.UtcNow < end)
            await Task.Delay(10);
        Assert.True(predicate());
    }

    [Theory]
    [InlineData("{broken")]
    [InlineData("[]")]
    [InlineData("{\"timers\":{}}")]
    [InlineData("{\"elsewhere\":[]}")]
    public async Task Malformed_whole_store_is_timer_only_unavailable_and_never_becomes_empty_or_overwritten(
        string payload
    )
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        var path = Path.Combine(temp.Path, "state", "timers.json");
        await File.WriteAllTextAsync(path, payload);
        await using var timers = new MainTimers(
            temp.Path,
            _ => throw new Xunit.Sdk.XunitException("Malformed store must not fire.")
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        Assert.NotNull(timers.Unavailable);
        Assert.Throws<TimerStoreUnavailableException>(() => timers.List("owner"));
        await Assert.ThrowsAsync<TimerStoreUnavailableException>(() =>
            timers.CreateAsync(
                Row("unused", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60000),
                default
            )
        );
        Assert.Equal(payload, await File.ReadAllTextAsync(path));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Unreadable_store_directory_or_dangling_parent_is_not_known_fresh_absence(
        bool parent
    )
    {
        using var temp = new TempDirectory();
        if (parent)
            Directory.CreateSymbolicLink(
                Path.Combine(temp.Path, "state"),
                Path.Combine(temp.Path, "missing-parent")
            );
        else
            Directory.CreateDirectory(Path.Combine(temp.Path, "state", "timers.json"));
        await using var timers = new MainTimers(temp.Path, _ => Task.CompletedTask)
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        Assert.NotNull(timers.Unavailable);
        Assert.Throws<TimerStoreUnavailableException>(() => timers.List("owner"));
    }

    [Fact]
    public async Task Unknown_values_fields_ambiguous_groups_and_unsupported_records_survive_healthy_CRUD_without_becoming_clocks()
    {
        using var temp = new TempDirectory();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var unknown = new JsonObject
        {
            ["id"] = "unknown",
            ["strange"] = new JsonArray(1, "raw\n</foxwarm-message>", false),
            ["payload"] = new JsonObject { ["extra"] = "雪" },
        };
        var unsupported = Row("remote", now - 1);
        unsupported["newSession"] = true;
        unsupported["currentNode"] = "elsewhere";
        var duplicate = Row("same", now - 1);
        var internalRow = Row("internal", now - 1, "");
        internalRow["waitTimeoutId"] = "wait";
        internalRow["waitTimeoutSeconds"] = 12;
        var rows = new JsonArray(
            unknown.DeepClone(),
            42,
            null,
            duplicate.DeepClone(),
            duplicate.DeepClone(),
            unsupported.DeepClone(),
            internalRow.DeepClone(),
            Row("healthy", now + 60000)
        );
        await Save(
            temp.Path,
            new JsonObject
            {
                ["timers"] = rows,
                ["extension"] = new JsonObject { ["keep"] = "line\nquoted\"" },
            }
        );
        await using var timers = new MainTimers(
            temp.Path,
            _ => throw new Xunit.Sdk.XunitException("No unsupported record may fire.")
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        await Task.Delay(30);
        Assert.Throws<InvalidDataException>(() => timers.Get("same", "owner"));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            timers.DeleteAsync("same", "owner", default)
        );
        var changed = timers.Get("healthy", "owner");
        changed["message"] = "updated";
        await timers.UpdateAsync("healthy", changed, default);
        var saved = Rows(temp.Path);
        Assert.Equal(8, saved.Count);
        for (var index = 0; index < 7; index++)
            Assert.True(JsonNode.DeepEquals(rows[index], saved[index]));
        Assert.Equal(
            "line\nquoted\"",
            JsonNode.Parse(
                await File.ReadAllTextAsync(Path.Combine(temp.Path, "state", "timers.json"))
            )!["extension"]!["keep"]!.GetValue<string>()
        );
        Assert.Equal(2, timers.List("owner").Count);
        Assert.Null(
            timers
                .List("owner")
                .OfType<JsonObject>()
                .Single(row => row["id"]!.GetValue<string>() == "remote")["nextRunAt"]
        );
        timers.WriteStage = _ => throw new IOException("Absent deletion must not write.");
        Assert.False(await timers.DeleteAsync("missing", "owner", default));
    }

    [Fact]
    public async Task Pre_rename_failure_never_publishes_and_post_rename_failure_publishes_the_real_future_registration()
    {
        using var temp = new TempDirectory();
        await using var timers = new MainTimers(temp.Path, _ => Task.CompletedTask)
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        var row = Row("unused", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60000);
        timers.WriteStage = stage =>
        {
            if (stage == AtomicJsonWriteStage.BeforeRename)
                throw new IOException("before");
        };
        await Assert.ThrowsAsync<IOException>(() => timers.CreateAsync(row, default));
        Assert.Empty(timers.List("owner"));
        Assert.False(File.Exists(Path.Combine(temp.Path, "state", "timers.json")));
        timers.WriteStage = stage =>
        {
            if (stage == AtomicJsonWriteStage.AfterRenameBeforeDirectorySync)
                throw new IOException("after");
        };
        var partial = await Assert.ThrowsAsync<TimerCommittedException>(() =>
            timers.CreateAsync(row, default)
        );
        Assert.NotEmpty(partial.TimerId);
        Assert.Equal(partial.TimerId, Rows(temp.Path).Single()!["id"]!.GetValue<string>());
        Assert.Single(timers.List("owner"));
        Assert.NotNull(timers.List("owner")[0]!["nextRunAt"]);
        timers.WriteStage = null;
    }

    [Fact]
    public async Task Old_once_completion_cannot_remove_a_normally_updated_replacement_and_delete_does_not_reverse_started_delivery()
    {
        foreach (var update in new[] { true, false })
        {
            using var temp = new TempDirectory();
            var entered = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            var release = new TaskCompletionSource(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            JsonObject? delivered = null;
            await using var timers = new MainTimers(
                temp.Path,
                async row =>
                {
                    entered.TrySetResult();
                    await release.Task;
                    delivered = row;
                }
            )
            {
                Diagnostic = (_, _) => { },
            };
            await timers.LoadAsync();
            timers.Start();
            var first = await timers.CreateAsync(
                Row("unused", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 40, "old"),
                default
            );
            var id = first["id"]!.GetValue<string>();
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (update)
            {
                var replacement = timers.Get(id, "owner");
                replacement["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60000;
                replacement["message"] = "replacement";
                await timers.UpdateAsync(id, replacement, default);
            }
            else
                Assert.True(await timers.DeleteAsync(id, "owner", default));
            release.TrySetResult();
            await WaitUntil(() => delivered is not null);
            await timers.DisposeAsync();
            Assert.Equal("old", delivered!["message"]!.GetValue<string>());
            if (update)
            {
                Assert.Single(Rows(temp.Path));
                Assert.Equal("replacement", Rows(temp.Path)[0]!["message"]!.GetValue<string>());
            }
            else
                Assert.Empty(Rows(temp.Path));
        }
    }

    [Fact]
    public async Task Once_failures_are_consumed_cron_failures_keep_last_trigger_and_shutdown_drains_accepted_completion()
    {
        using var temp = new TempDirectory();
        var count = 0;
        await using var timers = new MainTimers(
            temp.Path,
            _ =>
            {
                Interlocked.Increment(ref count);
                throw new IOException("delivery");
            }
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        await timers.CreateAsync(
            Row("unused", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1),
            default
        );
        await WaitUntil(() => count == 1 && Rows(temp.Path).Count == 0);
        var cron = new JsonObject
        {
            ["sessionId"] = "owner",
            ["message"] = "cron",
            ["cron"] = "* * * * * *",
            ["lastTriggeredAt"] = 7,
            ["createdAt"] = 1,
        };
        var saved = await timers.CreateAsync(cron, default);
        await WaitUntil(() => count >= 3);
        await timers.DisposeAsync();
        Assert.Equal(7, Rows(temp.Path)[0]!["lastTriggeredAt"]!.GetValue<int>());
        Assert.Equal(
            saved["id"]!.GetValue<string>(),
            Rows(temp.Path)[0]!["id"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Canonical_wait_proof_consumes_only_recognized_matching_or_stale_rows_and_never_arms_internal_deadlines()
    {
        using var temp = new TempDirectory();
        var rows = new JsonArray();
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var owner in new[] { "validated", "unknown", "unsupported" })
        {
            var row = Row(owner, now - 1, "");
            row["sessionId"] = owner;
            row["waitTimeoutId"] = "old";
            row["waitTimeoutSeconds"] = 1;
            if (owner == "unsupported")
                row["waitTimeoutSeconds"] = "unknown";
            rows.Add(row);
        }
        await Save(temp.Path, new JsonObject { ["timers"] = rows });
        await using var timers = new MainTimers(
            temp.Path,
            _ => throw new Xunit.Sdk.XunitException("Internal deadline cannot fire.")
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        await timers.ConsumeValidatedWaitAsync("validated", "different");
        await Task.Delay(30);
        Assert.Equal(2, Rows(temp.Path).Count);
        Assert.DoesNotContain(
            Rows(temp.Path).OfType<JsonObject>(),
            row => row["id"]!.GetValue<string>() == "validated"
        );
    }
}
