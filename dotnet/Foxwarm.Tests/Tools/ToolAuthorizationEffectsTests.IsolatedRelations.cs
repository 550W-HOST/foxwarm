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

    // The R0 relation guard is retired; the migrated layer limits send_to_session targets.
    [Fact]
    public async Task Migrated_sender_reaches_only_itself_and_direct_parent_or_child_while_incoming_stays_open()
    {
        using var temp = new TempDirectory();
        // alpha (isolated): opaque <- direct (child), peer (same Agent, unrelated); beta: foreign.
        await Seed(temp.Path, Obj("""{"isolated":true,"isolatedNode":"bound-node"}"""));
        await AddSession(temp.Path, "peer", "alpha", null);
        await using var manager = Manager(temp.Path);
        await manager.LoadAsync();
        var opaque = await manager.RequiredAsync("opaque");
        var direct = await manager.RequiredAsync("direct");
        var foreign = await manager.RequiredAsync("foreign");
        static JsonObject Send(string target) =>
            new() { ["sessionId"] = target, ["message"] = "x" };

        foreach (
            var (source, target, allowed) in new[]
            {
                (opaque, "foreign", false),
                (opaque, "outside", false),
                (opaque, "peer", false),
                (direct, "peer", false),
                (opaque, "kid", true),
                (direct, "<parent>", true),
                (direct, "self", true),
            }
        )
        {
            var execution = Executor(manager, source, temp.Path);
            await using var mcp = execution.Mcp;
            var response = await Call(execution.Tools, "send_to_session", Send(target));
            Assert.True(
                allowed == (Error(response) is null),
                $"{source.Id} -> {target}: {response.ToJsonString()}"
            );
        }
        Assert.Equal(0, Queued(foreign));
        Assert.Equal(0, Queued(await manager.RequiredAsync("peer")));

        // Incoming sends are governed by the sender's own policy.
        Assert.Equal(
            "opaque",
            await manager.SendAsync(foreign, "opaque", "x", Send("opaque"), trigger: false)
        );
        Assert.Equal(
            "peer",
            await manager.SendAsync(foreign, "peer", "x", Send("peer"), trigger: false)
        );
    }
}
