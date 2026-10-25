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
        var reached = Signal();
        var release = Signal();
        var hold = false;
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            Options,
            HostModels.ForTest(Options),
            canonicalCommitBarrier: async (_, _, _) =>
            {
                if (!hold)
                    return;
                reached.TrySetResult();
                await release.Task;
            }
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        hold = true;
        var first = ForkClearLifecycleTests.AppendAsync(owner, Text("Accepted old-binding row"));
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var move = manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "new" });
        Assert.False(move.IsCompleted);
        release.TrySetResult();
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

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Shared_channel_mutations_serialize_real_read_modify_write_without_lost_bindings(
        bool migration,
        bool twoDeletes
    )
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        var channels = Path.Combine(state, "channels.json");
        var bindings = new JsonObject
        {
            ["webui:first"] = new JsonObject { ["sessionId"] = "old", ["mode"] = "push-only" },
            ["webui:remove"] = new JsonObject { ["sessionId"] = "remove" },
            ["other:untouched"] = new JsonObject { ["sessionId"] = "foreign", ["custom"] = 42 },
        };
        await File.WriteAllTextAsync(
            migration ? Path.Combine(state, "sessions.json.pre-catalog-sqlite-v1.bak") : channels,
            new JsonObject
            {
                [migration ? "channelAttachments" : "channels"] = bindings,
            }.ToJsonString()
        );
        var reached = Signal();
        var release = Signal();
        var secondStarted = Signal();
        var authority = new SessionDeletionChannels(
            temp.Path,
            (id, stage) =>
            {
                if (
                    id != "old"
                    || stage
                        != (
                            migration ? "migration-before-write"
                            : twoDeletes ? "after-read"
                            : "identity-after-read"
                        )
                )
                    return;
                reached.TrySetResult();
                release.Task.WaitAsync(TimeSpan.FromSeconds(10)).GetAwaiter().GetResult();
            }
        );
        var first = Task.Run(() =>
        {
            if (twoDeletes)
                authority.Detach("old");
            else
                authority.RewriteIdentity("old", "new");
        });
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var second = Task.Run(() =>
            {
                secondStarted.TrySetResult();
                authority.Detach("remove");
            });
            await secondStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Task.Delay(30);
            Assert.False(second.IsCompleted);
            release.TrySetResult();
            await Task.WhenAll(first, second);
        }
        finally
        {
            release.TrySetResult();
            await first;
        }
        var actual = JsonNode.Parse(await File.ReadAllTextAsync(channels))!["channels"]!;
        Assert.Null(actual["webui:remove"]);
        if (twoDeletes)
            Assert.Null(actual["webui:first"]);
        else
        {
            Assert.Equal("new", actual["webui:first"]!["sessionId"]!.GetValue<string>());
            Assert.Equal("send-only", actual["webui:first"]!["mode"]!.GetValue<string>());
        }
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
