using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class ToolAuthorizationEffectsTests
{
    private static async Task AddSession(string root, string id, string agent, string? parent)
    {
        var data = Path.Combine(root, "data");
        await SessionCatalogMigrationTests.Authority(data, id);
        var file = Path.Combine(data, "state", "sessions", id + ".json");
        var state = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        state["agent"] = agent;
        await File.WriteAllTextAsync(file, state.ToJsonString());
        using var catalog = new SessionCatalog(data);
        catalog.Initialize();
        catalog.Upsert([SessionCatalogTests.Row(id, 0, parent, agent, [])]);
    }

    private static int Queued(SessionOwner owner) =>
        owner.Entry.WithState(state => state.Queue.Count);

    [Fact]
    public async Task Isolated_sender_reaches_only_itself_and_direct_parent_or_child_while_incoming_stays_open()
    {
        using var temp = new TempDirectory();
        // alpha (isolated): opaque <- direct (child), peer (same Agent, unrelated); beta: foreign.
        await Seed(temp.Path, Obj("""{"isolated":true,"isolatedNode":"bound-node"}"""));
        await AddSession(temp.Path, "peer", "alpha", null);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var opaque = await manager.RequiredAsync("opaque");
        var direct = await manager.RequiredAsync("direct");
        var peer = await manager.RequiredAsync("peer");
        var foreign = await manager.RequiredAsync("foreign");
        static JsonObject Send(string target) =>
            new() { ["sessionId"] = target, ["message"] = "x" };

        foreach (
            var (source, target) in new[]
            {
                (opaque, "foreign"),
                (opaque, "peer"),
                (direct, "peer"),
            }
        )
        {
            var receiver = await manager.RequiredAsync(target);
            var before = Queued(receiver);
            var denied = await Assert.ThrowsAsync<ToolAuthorizationDeniedException>(() =>
                manager.SendAsync(source, target, "x", Send(target), trigger: false)
            );
            Assert.Contains("direct parent/child", denied.Message);
            Assert.Equal(before, Queued(receiver));
        }

        // Direct links in both directions, by canonical ID, alias and <parent>.
        Assert.Equal(
            "direct",
            await manager.SendAsync(opaque, "kid", "x", Send("kid"), trigger: false)
        );
        Assert.Equal(
            "opaque",
            await manager.SendAsync(direct, "<parent>", "x", Send("<parent>"), trigger: false)
        );
        Assert.Equal(
            "opaque",
            await manager.SendAsync(direct, "self", "x", Send("self"), trigger: false)
        );

        // The incoming guard is retired: a nonisolated sender's own policy governs.
        Assert.Equal(
            "opaque",
            await manager.SendAsync(foreign, "opaque", "x", Send("opaque"), trigger: false)
        );
        Assert.Equal(
            "peer",
            await manager.SendAsync(foreign, "peer", "x", Send("peer"), trigger: false)
        );

        // The model tool path returns the handler's tool error and delivers nothing.
        var execution = Executor(manager, opaque, temp.Path);
        await using var mcp = execution.Mcp;
        var foreignQueued = Queued(foreign);
        var response = await Call(execution.Tools, "send_to_session", Send("outside"));
        Assert.NotNull(Error(response));
        Assert.Contains("direct parent/child", response["error"]!["message"]!.GetValue<string>());
        Assert.Equal(foreignQueued, Queued(foreign));
    }

    [Fact]
    public async Task Isolated_wait_dependencies_are_limited_to_direct_parent_or_child()
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, Obj("""{"isolated":true,"isolatedNode":"bound-node"}"""));
        await AddSession(temp.Path, "peer", "alpha", null);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var opaque = await manager.RequiredAsync("opaque");
        var direct = await manager.RequiredAsync("direct");
        var foreign = await manager.RequiredAsync("foreign");

        foreach (
            var (source, args) in new[]
            {
                (opaque, """{"waitAnySessions":["foreign"]}"""),
                (opaque, """{"waitAnySessions":["kid","peer"]}"""),
                (direct, """{"waitAllSessions":["<parent>","outside"]}"""),
            }
        )
        {
            var denied = Assert.Throws<ToolAuthorizationDeniedException>(() =>
                manager.ValidateWait(source, Obj(args))
            );
            Assert.Contains("direct parent/child", denied.Message);
        }

        Assert.NotNull(manager.ValidateWait(opaque, Obj("""{"waitAnySessions":["kid"]}""")));
        Assert.NotNull(manager.ValidateWait(direct, Obj("""{"waitAnySessions":["<parent>"]}""")));
        // Incoming dependencies on an isolated Agent's Sessions are not restricted.
        Assert.NotNull(
            manager.ValidateWait(foreign, Obj("""{"waitAllSessions":["opaque","peer"]}"""))
        );
    }
}
