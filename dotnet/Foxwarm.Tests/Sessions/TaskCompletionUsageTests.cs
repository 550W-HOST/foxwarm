using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TaskCompletionUsageTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        internal SessionManager Manager = null!;
        internal SessionOwner Creator = null!;
        internal SessionOwner Worker = null!;

        internal static async Task<Fixture> CreateAsync()
        {
            var f = new Fixture();
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            f.Manager = new SessionManager(
                Path.Combine(f.temp.Path, "data"),
                Path.Combine(f.temp.Path, "work"),
                options,
                HostModels.ForTest(options)
            );
            f.Manager.TopologyChanged += () =>
            {
                foreach (var owner in f.Manager.Owners())
                    owner.Registry.TriggerOverride = _ => Task.CompletedTask;
            };
            await f.Manager.LoadAsync();
            f.Creator = await f.Manager.CreateNamedAsync("main", "creator", null, null);
            f.Worker = await f.Manager.CreateNamedAsync("main", "worker", null, null);
            return f;
        }

        public async ValueTask DisposeAsync()
        {
            await Manager.ShutdownAsync();
            await Manager.DisposeAsync();
            temp.Dispose();
        }

        internal async Task<string> AssignAsync(string title)
        {
            var created = (
                await Manager.Tasks.ExecuteAsync(
                    new JsonObject
                    {
                        ["action"] = "create",
                        ["title"] = title,
                        ["ownerSessionId"] = Worker.Id,
                        ["notifySession"] = true,
                    },
                    Creator.Id
                )
            ).Payload;
            return created["task"]!["id"]!.GetValue<string>();
        }

        internal Task AppendRequestAsync(
            string modelId,
            double? cost,
            long timestamp,
            bool withUsage = true
        )
        {
            var meta = new JsonObject { ["timestamp"] = timestamp, ["modelId"] = modelId };
            JsonObject? usage = null;
            if (withUsage)
            {
                usage = new JsonObject
                {
                    ["inputTokens"] = 10,
                    ["outputTokens"] = 5,
                    ["cachedTokens"] = 0,
                };
                if (cost is not null)
                    usage["cost"] = cost;
                meta["usage"] = usage.DeepClone();
            }
            var message = new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "work" }),
                ["__meta"] = meta,
            };
            return Worker.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
                LocalSessionTurnHost.PrepareCanonicalAppend(
                    state,
                    [message],
                    [],
                    updateLastMessageTime: false,
                    finalizing: false,
                    () => timestamp,
                    usage
                )
            );
        }

        internal async Task<string> CompleteAsync(string taskId)
        {
            var before = Creator.Entry.Snapshot().Queue.Count;
            var completed = await Manager.Tasks.ExecuteForToolAsync(
                Worker,
                new JsonObject
                {
                    ["action"] = "complete",
                    ["taskId"] = taskId,
                    ["result"] = "done",
                }
            );
            Assert.Equal(
                "sent",
                SessionWait.Text(completed["task"]?["completionNotificationStatus"])
            );
            var queue = Creator.Entry.Snapshot().Queue;
            Assert.Equal(before + 1, queue.Count);
            return SessionWait.Text(Assert.Single(queue[^1].Parts!)["system"])!;
        }
    }

    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    [Fact]
    public async Task Completion_reports_distinct_models_and_summed_saved_costs_within_the_assignment_window()
    {
        await using var f = await Fixture.CreateAsync();
        var oldTime = Now() - 600_000;
        await f.AppendRequestAsync("old/model", 100, oldTime);
        var taskId = await f.AssignAsync("priced work");
        var start = Now();
        await f.AppendRequestAsync("a/m", .5, start + 1);
        await f.AppendRequestAsync("a/m", .25, start + 2);
        await f.AppendRequestAsync("b/n", 1, start + 3);
        // A request after completion is outside the window.
        await f.AppendRequestAsync("late/model", 50, start + 600_000);

        // Clearing removes active history; the recorded Archive rows still provide the total.
        await f.Manager.ClearAsync(f.Worker);
        Assert.Empty(f.Worker.Entry.Snapshot().History);

        var text = await f.CompleteAsync(taskId);
        Assert.Contains("\nTask owner usage: a/m, b/n; estimated cost $1.75 USD.", text);
        Assert.DoesNotContain("old/model", text);
        Assert.DoesNotContain("late/model", text);
    }

    [Fact]
    public async Task Completion_reports_unavailable_cost_when_any_included_request_has_none()
    {
        await using var f = await Fixture.CreateAsync();
        var taskId = await f.AssignAsync("partly priced");
        var start = Now();
        await f.AppendRequestAsync("a/m", 2, start + 1);
        await f.AppendRequestAsync("b/n", null, start + 2);
        await f.AppendRequestAsync("c/o", null, start + 3, withUsage: false);
        var text = await f.CompleteAsync(taskId);
        Assert.Contains("\nTask owner usage: a/m, b/n, c/o; estimated cost unavailable.", text);
    }

    [Fact]
    public async Task Completion_omits_the_usage_line_without_successful_requests()
    {
        await using var f = await Fixture.CreateAsync();
        var taskId = await f.AssignAsync("no requests");
        // Notices and commentary prefixes carry no concrete model attribution.
        await f.Worker.Entry.SaveLane.CommitCanonicalAppendAsync(state =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                state,
                [
                    new JsonObject
                    {
                        ["role"] = "model",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = "note" }),
                        ["__meta"] = new JsonObject
                        {
                            ["timestamp"] = Now() + 1,
                            ["llmSegment"] = new JsonObject(),
                        },
                    },
                ],
                [],
                updateLastMessageTime: false,
                finalizing: false,
                Now
            )
        );
        var text = await f.CompleteAsync(taskId);
        Assert.DoesNotContain("Task owner usage", text);
        Assert.Contains("Task completed:", text);
    }

    [Fact]
    public async Task Usage_window_starts_at_the_current_owners_own_assignment()
    {
        await using var f = await Fixture.CreateAsync();
        var taskId = await f.AssignAsync("transferred");
        var start = Now();
        await f.AppendRequestAsync("early/model", 7, start + 1);
        // Hand the task to another Session and back: only the last assignment counts.
        var other = await f.Manager.CreateNamedAsync("main", "other", null, null);
        await f.Manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = taskId,
                ["ownerSessionId"] = other.Id,
            },
            f.Creator.Id
        );
        await Task.Delay(20);
        await f.Manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = taskId,
                ["ownerSessionId"] = f.Worker.Id,
            },
            f.Creator.Id
        );
        var reassigned = Now();
        await f.AppendRequestAsync("late/model", .5, reassigned + 1);
        var text = await f.CompleteAsync(taskId);
        Assert.Contains("Task owner usage: late/model; estimated cost $0.50 USD.", text);
        Assert.DoesNotContain("early/model", text);
    }

    [Fact]
    public async Task Claim_records_the_assignment_time_and_the_internal_field_stays_out_of_task_json()
    {
        await using var f = await Fixture.CreateAsync();
        var created = (
            await f.Manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "create", ["title"] = "open work" },
                f.Creator.Id
            )
        ).Payload;
        var taskId = created["task"]!["id"]!.GetValue<string>();
        Assert.Null(f.Manager.Tasks.OwnerAssignedAt(taskId));
        var before = Now();
        var claimed = (
            await f.Manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "claim", ["taskId"] = taskId },
                f.Worker.Id
            )
        ).Payload;
        var assignedAt = f.Manager.Tasks.OwnerAssignedAt(taskId);
        Assert.True(assignedAt >= before && assignedAt <= Now());
        Assert.False(claimed["task"]!.AsObject().ContainsKey("ownerAssignedAt"));
        Assert.False(
            (
                await f.Manager.Tasks.ExecuteAsync(
                    new JsonObject { ["action"] = "get", ["taskId"] = taskId },
                    null
                )
            ).Payload["task"]!
                .AsObject()
                .ContainsKey("ownerAssignedAt")
        );
    }
}
