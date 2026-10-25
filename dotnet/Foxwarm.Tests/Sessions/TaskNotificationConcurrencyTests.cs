using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TaskNotificationConcurrencyTests
{
    [Fact]
    public async Task Title_updates_are_silent_and_an_opted_in_note_uses_the_replaced_title()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var actor = await manager.CreateNamedAsync("main", "actor", null, null);
        var owner = await manager.CreateNamedAsync("main", "owner", null, null);
        var created = await manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "original title",
                ["ownerSessionId"] = owner.Id,
            },
            actor.Id
        );
        var id = Text(created.Payload["task"]!["id"]);
        var authority = owner.Entry.Snapshot().AuthorityEnvelope.DeepClone();
        foreach (var withDescription in new[] { false, true })
        {
            var args = new JsonObject
            {
                ["action"] = "update",
                ["taskId"] = id,
                ["title"] = "silent title",
                ["notifySession"] = true,
            };
            if (withDescription)
                args["description"] = "shared scope";
            var updated = await manager.Tasks.ExecuteAsync(args, actor.Id);
            Assert.Equal(0, updated.Payload["sentNotifications"]!.GetValue<int>());
            Assert.Empty(owner.Entry.Snapshot().Queue);
            Assert.Empty(owner.Entry.Snapshot().History);
            Assert.True(JsonNode.DeepEquals(authority, owner.Entry.Snapshot().AuthorityEnvelope));
        }
        var noted = await manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "update",
                ["taskId"] = id,
                ["title"] = "notified title",
                ["note"] = "Please inspect the revised scope.",
                ["notifySession"] = true,
            },
            actor.Id
        );
        Assert.Equal(1, noted.Payload["sentNotifications"]!.GetValue<int>());
        var notice = Assert.Single(owner.Entry.Snapshot().Queue);
        Assert.True(notice.Trigger);
        var text = SessionWait.Text(Assert.Single(notice.Parts!)["system"]);
        Assert.Contains("notified title", text);
        Assert.Contains("Please inspect the revised scope.", text);
        await manager.ShutdownAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Held_recipient_allows_unrelated_work_and_overtaking_assignment_keeps_its_revision_and_payload(
        bool userAssignment
    )
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var actor = await manager.CreateNamedAsync("main", "actor", null, null);
        var previous = await manager.CreateNamedAsync("main", "previous", null, null);
        var next = await manager.CreateNamedAsync("main", "next", null, null);
        var latest = await manager.CreateNamedAsync("main", "latest", null, null);
        var originalDescription = new string('D', 6000) + " ORIGINAL_ASSIGNMENT_END";
        var created = await manager.Tasks.ExecuteAsync(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "concurrent assignment",
                ["description"] = originalDescription,
                ["ownerSessionId"] = previous.Id,
            },
            actor.Id
        );
        var id = Text(created.Payload["task"]!["id"]);
        var releasePrevious = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var releaseLatest = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var previousEntered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var latestEntered = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        // Hold ordinary recipient persistence, not Task storage or an injected delivery substitute.
        var previousSave = previous.Entry.SaveLane.MutateIdentityAsync(async () =>
        {
            previousEntered.SetResult();
            await releasePrevious.Task;
        });
        var latestSave = latest.Entry.SaveLane.MutateIdentityAsync(async () =>
        {
            latestEntered.SetResult();
            await releaseLatest.Task;
        });
        try
        {
            await Task.WhenAll(previousEntered.Task, latestEntered.Task);
            var args = new JsonObject
            {
                ["action"] = "assign",
                ["taskId"] = id,
                ["ownerSessionId"] = next.Id,
                ["notifySession"] = true,
            };
            var earlier = userAssignment
                ? manager.Tasks.ExecuteAsUserAsync(args)
                : SessionAction(args);
            Assert.Equal(next.Id, manager.Tasks.OwnerSessionId(id));
            Assert.False(earlier.IsCompleted);

            var list = await manager
                .Tasks.ExecuteAsync(
                    new JsonObject { ["action"] = "list", ["scope"] = "all" },
                    actor.Id
                )
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Single(list.Payload["tasks"]!.AsArray());
            var unrelated = await manager
                .Tasks.ExecuteAsync(
                    new JsonObject { ["action"] = "create", ["title"] = "unrelated" },
                    actor.Id
                )
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.NotEqual(id, Text(unrelated.Payload["task"]!["id"]));
            await manager
                .Tasks.ExecuteAsync(
                    new JsonObject
                    {
                        ["action"] = "update",
                        ["taskId"] = id,
                        ["description"] = "LATER_DESCRIPTION",
                    },
                    actor.Id
                )
                .WaitAsync(TimeSpan.FromSeconds(5));

            var later = SessionAction(
                new JsonObject
                {
                    ["action"] = "assign",
                    ["taskId"] = id,
                    ["ownerSessionId"] = latest.Id,
                    ["notifySession"] = true,
                }
            );
            Assert.Equal(latest.Id, manager.Tasks.OwnerSessionId(id));
            Assert.False(later.IsCompleted);
            Assert.Equal("pending", Text((await Get())["assignmentNotificationStatus"]));

            releasePrevious.SetResult();
            await previousSave;
            var earlierResult = await earlier.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(2, earlierResult["sentNotifications"]!.GetValue<int>());
            Assert.Null(earlierResult["warning"]);
            // Old delivery really succeeded, but must not settle the newer pending revision.
            var current = await Get();
            Assert.Equal(latest.Id, Text(current["ownerSessionId"]));
            Assert.Equal("pending", Text(current["assignmentNotificationStatus"]));
            Assert.False(later.IsCompleted);
            var assignmentNotice = next.Entry.Snapshot().Queue.Single(item => item.Trigger);
            var assignmentText = SessionWait.Text(Assert.Single(assignmentNotice.Parts!)["system"]);
            Assert.Contains(originalDescription, assignmentText);
            Assert.DoesNotContain("LATER_DESCRIPTION", assignmentText);
            Assert.Contains("Status: active", assignmentText);
            Assert.Contains(
                userAssignment ? "sourceKind=\"user\"" : "sourceSessionId=",
                assignmentText
            );
            Assert.Single(previous.Entry.Snapshot().Queue);

            releaseLatest.SetResult();
            await latestSave;
            var laterResult = await later.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(2, laterResult["sentNotifications"]!.GetValue<int>());
            current = await Get();
            Assert.Equal("sent", Text(current["assignmentNotificationStatus"]));
            Assert.Equal("sent", Text(current["previousOwnerNotificationStatus"]));
            var latestText = SessionWait.Text(
                Assert.Single(Assert.Single(latest.Entry.Snapshot().Queue).Parts!)["system"]
            );
            Assert.Contains("LATER_DESCRIPTION", latestText);
            Assert.DoesNotContain(originalDescription, latestText);
            Assert.Empty(previous.Entry.Snapshot().History);
            Assert.Empty(next.Entry.Snapshot().History);
        }
        finally
        {
            releasePrevious.TrySetResult();
            releaseLatest.TrySetResult();
            await Task.WhenAll(previousSave, latestSave);
        }
        await manager.ShutdownAsync();

        async Task<JsonObject> SessionAction(JsonObject args) =>
            (await manager.Tasks.ExecuteAsync(args, actor.Id)).Payload;
        async Task<JsonNode> Get() =>
            (
                await manager
                    .Tasks.ExecuteAsync(
                        new JsonObject { ["action"] = "get", ["taskId"] = id },
                        null
                    )
                    .WaitAsync(TimeSpan.FromSeconds(5))
            ).Payload["task"]!;
    }

    [Fact]
    public async Task Child_preflight_through_attachment_serializes_mutations_but_does_not_block_reads()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var created = await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "create", ["title"] = "attach child" },
            parent.Id
        );
        var id = Text(created.Payload["task"]!["id"]);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var attaching = manager.Tasks.CreateAttachedChildAsync(
            id,
            parent.Id,
            async () =>
            {
                var child = (
                    await manager.CreateChildAsync(parent, "child", null, null, null, null)
                ).Child;
                entered.SetResult();
                await release.Task;
                return child;
            }
        );
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var read = await manager
                .Tasks.ExecuteAsync(new JsonObject { ["action"] = "get", ["taskId"] = id }, null)
                .WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Null(read.Payload["task"]!["attachedSessionId"]);
            var cancelling = manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "cancel", ["taskId"] = id },
                parent.Id
            );
            Assert.False(cancelling.IsCompleted);
            release.SetResult();
            var attached = await attaching.WaitAsync(TimeSpan.FromSeconds(5));
            var cancelled = await cancelling.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(attached.Child.Id, Text(cancelled.Payload["task"]!["attachedSessionId"]));
            Assert.Equal("cancelled", Text(cancelled.Payload["task"]!["status"]));
            Assert.True(attached.AssignmentDelivered);
            Assert.Equal(1, attached.SentNotifications);
            var notice = SessionWait.Text(
                Assert.Single(Assert.Single(attached.Child.Entry.Snapshot().Queue).Parts!)["system"]
            );
            Assert.Contains("Status: active", notice);
        }
        finally
        {
            release.TrySetResult();
            await attaching;
        }
        await manager.ShutdownAsync();
    }

    private static string Text(JsonNode? node) => node!.GetValue<string>();

    private static SessionManager Manager(string root)
    {
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        var manager = new SessionManager(
            Path.Combine(root, "data"),
            Path.Combine(root, "work"),
            options,
            HostModels.ForTest(options)
        );
        manager.TopologyChanged += () =>
        {
            foreach (var owner in manager.Owners())
                owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        };
        return manager;
    }
}
