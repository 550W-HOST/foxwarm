using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TaskChildDeliveryTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    [Fact]
    public async Task Failed_new_owner_delivery_keeps_committed_child_and_does_not_report_success()
    {
        using var temp = new TempDirectory();
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "main", null, null);
        var created = await manager.Tasks.ExecuteAsync(
            new JsonObject { ["action"] = "create", ["title"] = "delivery failure" },
            parent.Id
        );
        var taskId = created.Payload["task"]!["id"]!.GetValue<string>();
        SessionOwner? committedChild = null;
        var result = await manager.Tasks.CreateAttachedChildAsync(
            taskId,
            parent.Id,
            async () =>
            {
                var child = (
                    await manager.CreateChildAsync(parent, "vanished", null, null, null, null)
                ).Child;
                committedChild = child;
                var faults = Path.Combine(temp.Path, "data", "state", "experiment-faults");
                Directory.CreateDirectory(faults);
                await File.WriteAllTextAsync(
                    Path.Combine(
                        faults,
                        SessionIdentity.ExecDirectorySegment(child.Id) + ".catalog-projection"
                    ),
                    "fail"
                );
                return child;
            },
            "delivery failure message"
        );

        Assert.NotNull(committedChild);
        Assert.NotNull(manager.Catalog.Get(committedChild!.Id));
        Assert.False(result.AssignmentDelivered);
        Assert.Contains("new owner notification", result.Warning);
        var task = (
            await manager.Tasks.ExecuteAsync(
                new JsonObject { ["action"] = "get", ["taskId"] = taskId },
                null
            )
        ).Payload["task"]!;
        Assert.Equal(committedChild.Id, task["ownerSessionId"]!.GetValue<string>());
        Assert.Equal(committedChild.Id, task["attachedSessionId"]!.GetValue<string>());
        Assert.Equal("failed", task["assignmentNotificationStatus"]!.GetValue<string>());
    }

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } =
            System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "foxwarm-task-child-" + Guid.NewGuid()
            );

        internal TempDirectory() => Directory.CreateDirectory(Path);

        public void Dispose() => Directory.Delete(Path, true);
    }
}
