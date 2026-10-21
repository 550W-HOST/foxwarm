using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Timers;

namespace Foxwarm.Tests;

public sealed class ScriptTimerSchedulingTests
{
    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static JsonObject Script(double? at = null, string? cron = null) =>
        new()
        {
            ["sessionId"] = "owner",
            ["message"] = "",
            ["action"] = "toolscript",
            ["script"] = new JsonObject { ["code"] = "return 1" },
            ["createdAt"] = 1,
            ["at"] = at,
            ["cron"] = cron,
        };

    private static JsonArray Rows(string root) =>
        JsonNode.Parse(File.ReadAllText(Path.Combine(root, "state", "timers.json")))![
            "timers"
        ]!.AsArray();

    private static async Task Until(Func<bool> ready)
    {
        var end = DateTime.UtcNow.AddSeconds(6);
        while (!ready() && DateTime.UtcNow < end)
            await Task.Delay(10);
        Assert.True(ready());
    }

    [Fact]
    public async Task Cron_overlap_is_skipped_including_admission_and_shutdown_drains_only_the_accepted_initial_slice()
    {
        using var temp = new TempDirectory();
        var reached = Signal();
        var release = Signal();
        var count = 0;
        var admitted = 0;
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
        timers.BeforeDelivery = async _ =>
        {
            Interlocked.Increment(ref admitted);
            reached.TrySetResult();
            await release.Task;
        };
        await timers.LoadAsync();
        timers.Start();
        await timers.CreateAsync(Script(cron: "* * * * * *"), default);
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await Task.Delay(2200); // Two actual cron opportunities while owner admission is held.
            Assert.Equal(1, admitted);
            Assert.Equal(0, count);
            var stop = timers.DisposeAsync().AsTask();
            Assert.False(stop.IsCompleted);
            release.TrySetResult();
            await stop.WaitAsync(TimeSpan.FromSeconds(3));
            Assert.Equal(1, count);
            Assert.NotNull(Rows(temp.Path).Single()!["lastTriggeredAt"]);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Successful_or_failed_old_message_delivery_cannot_consume_accepted_message_to_script_replacement(
        bool fail
    )
    {
        using var temp = new TempDirectory();
        var reached = Signal();
        var release = Signal();
        await using var timers = new MainTimers(
            temp.Path,
            async _ =>
            {
                reached.TrySetResult();
                await release.Task;
                if (fail)
                    throw new IOException("old delivery failed");
            }
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        var message = Script(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 20);
        message.Remove("action");
        message.Remove("script");
        message["message"] = "old";
        var first = await timers.CreateAsync(message, default);
        var id = SessionWait.Text(first["id"])!;
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var replacement = timers.Get(id, "owner");
            replacement["action"] = "toolscript";
            replacement["message"] = "";
            replacement["script"] = new JsonObject { ["code"] = "return 42" };
            replacement["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60000;
            await timers.UpdateAsync(id, replacement, default);
            release.TrySetResult();
            await timers.DisposeAsync();
            var saved = Assert.Single(Rows(temp.Path))!;
            Assert.Equal("toolscript", SessionWait.Text(saved["action"]));
            Assert.Equal("return 42", SessionWait.Text(saved["script"]!["code"]));
            Assert.Null(saved["lastTriggeredAt"]);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Inflight_update_reschedules_overdue_once_replacement_or_delete_retains_prior_effect(
        bool delete
    )
    {
        using var temp = new TempDirectory();
        var reached = Signal();
        var release = Signal();
        var replacementRan = Signal();
        var calls = 0;
        await using var timers = new MainTimers(
            temp.Path,
            async _ =>
            {
                var call = Interlocked.Increment(ref calls);
                if (call == 1)
                {
                    reached.TrySetResult();
                    await release.Task;
                }
                else
                    replacementRan.TrySetResult();
            }
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        var first = await timers.CreateAsync(
            Script(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 20),
            default
        );
        var id = SessionWait.Text(first["id"])!;
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(3));
            if (delete)
                Assert.True(await timers.DeleteAsync(id, "owner", default));
            else
            {
                var replacement = timers.Get(id, "owner");
                replacement["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 20;
                await timers.UpdateAsync(id, replacement, default);
                await Task.Delay(80);
                Assert.Equal(1, calls);
            }
            release.TrySetResult();
            if (!delete)
                await replacementRan.Task.WaitAsync(TimeSpan.FromSeconds(3));
            await Until(() => Rows(temp.Path).Count == 0);
            await timers.DisposeAsync();
            Assert.Equal(delete ? 1 : 2, calls);
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Invalid_persisted_script_payload_is_retained_unarmed_without_poisoning_other_message_timers()
    {
        using var temp = new TempDirectory();
        var invalid = Script(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1);
        invalid["id"] = "invalid-script";
        invalid["script"] = new JsonObject { ["code"] = "return args", ["argsJson"] = "{broken" };
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "timers.json"),
            new JsonObject { ["timers"] = new JsonArray(invalid) }.ToJsonString()
        );
        await using var timers = new MainTimers(
            temp.Path,
            _ => throw new InvalidOperationException("Invalid script must not execute.")
        )
        {
            Diagnostic = (_, _) => { },
        };
        await timers.LoadAsync();
        timers.Start();
        Assert.Null(timers.Unavailable);
        var message = Script(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60000);
        message.Remove("action");
        message.Remove("script");
        message["message"] = "healthy";
        await timers.CreateAsync(message, default);
        Assert.Equal(2, Rows(temp.Path).Count);
        Assert.Equal("{broken", SessionWait.Text(Rows(temp.Path)[0]!["script"]!["argsJson"]));
        Assert.Null(
            timers.List("owner").Single(row => SessionWait.Text(row?["id"]) == "invalid-script")![
                "nextRunAt"
            ]
        );
    }
}
