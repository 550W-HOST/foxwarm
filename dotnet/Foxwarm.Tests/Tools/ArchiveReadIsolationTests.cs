using System.Reflection;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ArchiveReadIsolationTests
{
    // Read the production-created dispatcher without replacing its registry or caller authority.
    private static SessionToolExecutor Tools(SessionOwner owner)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
        var hosts = typeof(SessionRegistry).GetField("hosts", flags)!.GetValue(owner.Registry)!;
        return (SessionToolExecutor)
            typeof(LocalSessionTurnHostFactory).GetField("tools", flags)!.GetValue(hosts)!;
    }

    private static async Task<JsonObject> Read(
        SessionOwner source,
        string tool,
        bool unified,
        string? target = null
    )
    {
        var args = new JsonObject();
        if (target is not null)
            args["sessionId"] = target;
        var executor = Tools(source);
        executor.BeginTurn();
        return (
            await executor.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString("N"),
                    ["name"] = unified ? "call_tool" : tool,
                    ["args"] = unified
                        ? new JsonObject
                        {
                            ["source"] = "builtin",
                            ["name"] = tool,
                            ["args"] = args,
                        }
                        : args,
                },
                default
            )
        )!.AsObject();
    }

    private static async Task Seed(SessionOwner owner, string marker)
    {
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = marker }),
            }
        );
        owner.Archive.WriteBlocks([
            new ArchiveBlockRecord(
                owner.Id,
                owner.Agent,
                1,
                1,
                "message",
                1,
                1,
                null,
                1,
                1,
                1000,
                1000,
                marker,
                null,
                1000
            ),
        ]);
    }

    private static void Contains(JsonObject result, string marker)
    {
        Assert.Null(result["error"]);
        Assert.Contains(marker, result["output"]!.GetValue<string>());
    }

    private static void Denied(JsonObject result, string marker)
    {
        Assert.NotNull(result["error"]);
        Assert.DoesNotContain(marker, result.ToJsonString());
    }

    [Theory]
    [InlineData("get_archived_messages", false)]
    [InlineData("get_archived_messages", true)]
    [InlineData("get_archived_blocks", false)]
    [InlineData("get_archived_blocks", true)]
    public async Task Production_dispatch_keeps_same_Agent_guard_for_live_cleared_and_deleted_archive(
        string tool,
        bool unified
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var admin = await manager.CreateNamedAsync("main", "admin", null, null);
        var foreign = await manager.CreateNamedAsync("main", "foreign", null, null);
        await Seed(foreign, "FOREIGN-RETAINED-CONTENT");
        await manager.CreateAgentAsync("reader", true);
        var reader = await manager.RequiredAsync("reader/main");
        manager.Nodes.Registry.Create("offline-bound-node");
        await Seed(reader, "OWN-CONTENT");
        var sibling = await manager.CreateNamedAsync("reader", "sibling", null, null);
        await Seed(sibling, "SIBLING-CONTENT");
        // Catalog identity, not the apparent Agent prefix of a live alias, owns the target.
        var moved = await manager.CreateNamedAsync("main", "former-main", null, null);
        await Seed(moved, "MOVED-OWN-CONTENT");
        await manager.MoveIdentityAsync(
            admin,
            new JsonObject
            {
                ["sessionId"] = moved.Id,
                ["newSessionId"] = "moved",
                ["newAgentName"] = "reader",
            }
        );
        await manager.SetAgentIsolationAsync("reader", "offline-bound-node", true, new JsonArray());
        Contains(await Read(reader, tool, unified), "OWN-CONTENT");
        Contains(await Read(reader, tool, unified, sibling.Id), "SIBLING-CONTENT");
        Contains(await Read(reader, tool, unified, "former-main"), "MOVED-OWN-CONTENT");
        Contains(await Read(admin, tool, unified, foreign.Id), "FOREIGN-RETAINED-CONTENT");
        Contains(await Read(admin, tool, unified, reader.Id), "OWN-CONTENT");
        Denied(await Read(reader, tool, unified, foreign.Id), "FOREIGN-RETAINED-CONTENT");
        var missing = "reader/missing";
        Assert.Null((await Read(reader, tool, unified, missing))["error"]);
        Assert.Null(await manager.GetExistingAsync(missing));
        var unrelatedMissing = await Read(reader, tool, unified, "other/missing");
        Assert.NotNull(unrelatedMissing["error"]);

        // An exact capability grant cannot bypass the independent read restriction.
        await manager.SetAgentIsolationAsync(
            "reader",
            "offline-bound-node",
            true,
            new JsonArray(
                new JsonObject
                {
                    ["effect"] = "allow",
                    ["source"] = "builtin",
                    ["tool"] = tool,
                }
            )
        );
        Denied(await Read(reader, tool, unified, foreign.Id), "FOREIGN-RETAINED-CONTENT");
        await manager.ClearAsync(foreign);
        await manager.ClearAsync(sibling);
        Denied(await Read(reader, tool, unified, foreign.Id), "FOREIGN-RETAINED-CONTENT");
        Contains(await Read(reader, tool, unified, sibling.Id), "SIBLING-CONTENT");
        await manager.DeleteAsync(foreign.Id, source: admin);
        await manager.DeleteAsync(sibling.Id, source: admin);
        Denied(await Read(reader, tool, unified, foreign.Id), "FOREIGN-RETAINED-CONTENT");
        Contains(await Read(reader, tool, unified, sibling.Id), "SIBLING-CONTENT");
        Contains(await Read(admin, tool, unified, foreign.Id), "FOREIGN-RETAINED-CONTENT");
        Assert.Null(manager.Catalog.Get(foreign.Id));
        Assert.Null(manager.Catalog.Get(sibling.Id));
        Assert.Null(await manager.GetExistingAsync(sibling.Id));

        await manager.Authorization.InstallAsync(
            System.Text.Encoding.UTF8.GetBytes(
                $"version: 1\nrules:\n  - action: deny\n    tool: {{source: builtin, name: {tool}}}\n"
            ),
            default
        );
        Denied(await Read(reader, tool, unified), "OWN-CONTENT");
        Denied(await Read(admin, tool, unified, foreign.Id), "FOREIGN-RETAINED-CONTENT");
    }
}
