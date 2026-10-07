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
