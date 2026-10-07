using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class TaskStoreTests
{
    [Fact]
    public void CreateClaimUpdateAndTerminalCompletionAreDurable()
    {
        using var temp = new TempDirectory();
        using var store = new TaskStore(temp.Path, id => id == "old" ? "main" : id, _ => []);
        var created = store.Execute(
            new JsonObject
            {
                ["action"] = "create",
                ["title"] = "task",
                ["description"] = new string('d', 4000),
            },
            "old"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        var claimed = store.Execute(
            new JsonObject { ["action"] = "claim", ["taskId"] = id },
            "main"
        );
        Assert.Equal("active", claimed.Payload["task"]!["status"]!.GetValue<string>());
        var updated = store.Execute(
            new JsonObject
            {
                ["action"] = "update",
                ["taskId"] = id,
                ["note"] = "progress",
            },
            "main"
        );
        Assert.Equal("active", updated.Payload["task"]!["status"]!.GetValue<string>());
        var completed = store.Execute(
            new JsonObject
            {
                ["action"] = "complete",
                ["taskId"] = id,
                ["result"] = new string('r', 4000),
            },
            "main"
        );
        Assert.Equal("completed", completed.Payload["task"]!["status"]!.GetValue<string>());
        Assert.Throws<TaskError>(() =>
            store.Execute(new JsonObject { ["action"] = "complete", ["taskId"] = id }, "main")
        );
    }

    [Fact]
    public async Task IndependentConnectionsAllowOnlyOneSuccessfulClaim()
    {
        using var temp = new TempDirectory();
        using var first = new TaskStore(temp.Path, id => id, _ => []);
        using var second = new TaskStore(temp.Path, id => id, _ => []);
        var created = first.Execute(
            new JsonObject { ["action"] = "create", ["title"] = "race" },
            "creator"
        );
        var id = created.Payload["task"]!["id"]!.GetValue<string>();
        var results = await Task.WhenAll(
            Task.Run(() => TryClaim(first, id, "one")),
            Task.Run(() => TryClaim(second, id, "two"))
        );
        Assert.Equal(1, results.Count(value => value));
        Assert.Equal(
            "active",
            first.Execute(new JsonObject { ["action"] = "get", ["taskId"] = id }, null).Payload[
                "task"
            ]!["status"]!.GetValue<string>()
        );
    }

    private static bool TryClaim(TaskStore store, string id, string actor)
    {
        try
        {
            store.Execute(new JsonObject { ["action"] = "claim", ["taskId"] = id }, actor);
            return true;
        }
        catch (TaskError)
        {
            return false;
        }
    }

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } =
            System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "foxwarm-task-tests-" + Guid.NewGuid().ToString("N")
            );

        public TempDirectory() => Directory.CreateDirectory(Path);

        public void Dispose() => Directory.Delete(Path, true);
    }
}
