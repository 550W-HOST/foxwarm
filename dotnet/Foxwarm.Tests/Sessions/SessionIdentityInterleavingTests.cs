using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class SessionIdentityInterleavingTests
{
    private static JsonObject Text(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static SessionManager Manager(string root) =>
        new(
            Path.Combine(root, "data"),
            Path.Combine(root, "work"),
            Options,
            HostModels.ForTest(Options)
        );

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static async Task WaitFor(Func<bool> check)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!check())
            await Task.Delay(2, timeout.Token);
    }

    [Fact]
    public async Task Concurrent_parent_updates_reconcile_hot_authority_with_catalog()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var child = await manager.CreateNamedAsync("main", "child", null, null);

        var updates = Enumerable
            .Range(0, 200)
            .Select(index =>
                Task.Run(() =>
                    manager.ChangePresentation(catalog =>
                        catalog.SetParent("child", index % 2 == 0 ? parent.Id : null)
                    )
                )
            )
            .ToArray();
        await Task.WhenAll(updates);

        var catalogParent = SessionCatalog.Text(manager.Catalog.Get("child")!["parentSessionId"]);
        Assert.Equal(catalogParent, child.Metadata().ParentSessionId);
    }

    [Fact]
    public async Task Ordered_accepted_canonical_save_precedes_move_and_later_save_uses_current_binding()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        var marker = Path.Combine(
            temp.Path,
            "data",
            "state",
            "experiment-faults",
            SessionIdentity.ExecDirectorySegment("old") + ".canonical-hold-before-rename"
        );
        Directory.CreateDirectory(Path.GetDirectoryName(marker)!);
        await File.WriteAllTextAsync(marker, "hold");
        var first = ForkClearLifecycleTests.AppendAsync(owner, Text("Accepted old-binding row"));
        await WaitFor(() => File.Exists(marker + ".reached"));
        var move = manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "new" });
        Assert.False(move.IsCompleted);
        File.Delete(marker);
        await first;
        await move;
        await ForkClearLifecycleTests.AppendAsync(owner, Text("New-binding row"));
        Assert.Equal(
            new[] { "new", "new" },
            owner.Archive.ReadMessages().Select(row => row.SessionId)
        );
        Assert.Equal(2, owner.Entry.Snapshot().History.Count);
        Assert.False(File.Exists(Path.Combine(temp.Path, "data", "state", "sessions", "old.json")));
        Assert.Same(owner, await manager.RequiredAsync("old"));
    }

    [Fact]
    public async Task Partial_delete_retry_keeps_original_source_lifetime_after_move_and_does_not_touch_completed_survivor()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var source = await manager.CreateNamedAsync("main", "caller", null, null);
        var root = await manager.CreateNamedAsync("main", "root", null, null);
        var a = await manager.CreateNamedAsync("main", "a", null, null);
        var b = await manager.CreateNamedAsync("main", "b", null, null);
        manager.ChangePresentation(catalog => catalog.SetParent("a", "root"));
        manager.ChangePresentation(catalog => catalog.SetParent("b", "root"));
        manager.BeforeDeleteStage = (stage, id) =>
        {
            if (stage == "detach" && id == "b")
                throw new IOException("Actual second-survivor failure.");
            return Task.CompletedTask;
        };
        var partial = await Assert.ThrowsAsync<SessionDeletionException>(() =>
            manager.DeleteAsync("root", source: source)
        );
        Assert.Equal("a", partial.Details["detachedChildSessionIds"]![0]!.GetValue<string>());
        await manager.MoveIdentityAsync(
            source,
            new JsonObject { ["newSessionId"] = "current-caller" }
        );
        await manager.MoveIdentityAsync(
            source,
            new JsonObject { ["sessionId"] = "a", ["newSessionId"] = "moved-survivor" }
        );
        var reached = Signal();
        var release = Signal();
        manager.BeforeDeleteStage = async (stage, id) =>
        {
            if (stage == "detach" && id == "b")
            {
                reached.TrySetResult();
                await release.Task;
            }
        };
        var retry = manager.DeleteAsync("root", source: source);
        await reached.Task;
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            manager.MoveIdentityAsync(
                source,
                new JsonObject { ["newSessionId"] = "another-caller" }
            )
        );
        Assert.Equal("current-caller", source.Id);
        release.TrySetResult();
        var done = await retry;
        Assert.True(done["continuedSameHost"]!.GetValue<bool>());
        Assert.Same(a, await manager.RequiredAsync("moved-survivor"));
        Assert.Null(manager.Catalog.Get("moved-survivor")!["parentSessionId"]);
        Assert.Null(manager.Catalog.Get("b")!["parentSessionId"]);
        await ForkClearLifecycleTests.AppendAsync(
            source,
            Text("Same original caller remains healthy")
        );
        Assert.Equal("current-caller", source.Archive.ReadMessages().Single().SessionId);
    }

    [Fact]
    public async Task Shared_channel_authority_serializes_move_and_unrelated_real_deletion_without_lost_bindings()
    {
        using var temp = new TempDirectory();
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        await manager.CreateNamedAsync("main", "remove", null, null);
        var channels = Path.Combine(temp.Path, "data", "state", "channels.json");
        await File.WriteAllTextAsync(
            channels,
            "{\"channels\":{\"telegram:keep\":{\"sessionId\":\"old\",\"mode\":\"push-only\"},\"webui:remove\":{\"sessionId\":\"remove\"},\"other:untouched\":{\"sessionId\":\"foreign\",\"custom\":42}}}"
        );
        var hold = Path.Combine(
            temp.Path,
            "data",
            "state",
            "experiment-faults",
            SessionIdentity.ExecDirectorySegment("old") + ".channels-identity-after-read-hold"
        );
        Directory.CreateDirectory(Path.GetDirectoryName(hold)!);
        await File.WriteAllTextAsync(hold, "hold");
        var move = Task.Run(() =>
            manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "new" })
        );
        await WaitFor(() => File.Exists(hold + ".reached"));
        var deletion = Task.Run(() => manager.DeleteAsync("remove"));
        await Task.Delay(30);
        Assert.False(deletion.IsCompleted);
        File.Delete(hold);
        await move;
        await deletion;
        var actual = JsonNode.Parse(await File.ReadAllTextAsync(channels))!["channels"]!;
        Assert.Equal("new", actual["telegram:keep"]!["sessionId"]!.GetValue<string>());
        Assert.Equal("send-only", actual["telegram:keep"]!["mode"]!.GetValue<string>());
        Assert.Null(actual["webui:remove"]);
        Assert.Equal(42, actual["other:untouched"]!["custom"]!.GetValue<int>());
    }

    [Fact]
    public async Task Discovery_schema_exposes_exact_nondefault_move_structure_without_handoff_protocol()
    {
        var definition = AgentToolDefinitions
            .Definitions()
            .Single(row => row["name"]!.GetValue<string>() == "move_session");
        Assert.Equal(
            new[]
            {
                "sessionId",
                "newSessionId",
                "createAgent",
                "newAgentName",
                "createAgentInheritMemory",
                "parentSessionId",
            },
            definition["parameters"]!["properties"]!.AsObject().Select(pair => pair.Key)
        );
        Assert.Null(definition["parameters"]!["required"]);
        Assert.False(HandoffConfirmation.Handoff("move_session"));
        using var temp = new TempDirectory();
        await using var mcp = new Foxwarm.McpClient(temp.Path);
        var registry = SessionToolExecutor.CreateRegistry(
            new JsonArray(definition.DeepClone()),
            mcp,
            _ => temp.Path
        );
        var entry = registry.Entries.Single(value =>
            value.Definition["name"]!.GetValue<string>() == "move_session"
        );
        Assert.Equal("builtin", entry.Source);
        Assert.False(entry.DefaultInject);
        Assert.DoesNotContain(
            registry.ModelDefinitions().OfType<JsonObject>(),
            value => value["name"]!.GetValue<string>() == "move_session"
        );
    }
}
