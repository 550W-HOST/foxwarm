using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class SessionListQueryTests
{
    private static async Task<JsonObject> List(OutboundMcpFixture f, JsonObject args)
    {
        args["action"] = "list";
        var result = await f.Manager.ObserveAsync(f.First, "session", args);
        Assert.Null(result["output"]);
        return result;
    }

    private static string[] Ids(JsonObject list) =>
        list["sessions"]!.AsArray().Select(row => row!["id"]!.GetValue<string>()).ToArray();

    [Fact]
    public async Task List_query_filters_metadata_within_scope_before_pagination()
    {
        await using var f = await OutboundMcpFixture.CreateAsync();
        await f.Manager.CreateAgentAsync("ops", false);
        var named = await f.Manager.CreateNamedAsync("main", "notes", null, null);
        var other = await f.Manager.CreateNamedAsync("ops", "release-check", null, null);
        named.Registry.TriggerOverride = _ => Task.CompletedTask;
        other.Registry.TriggerOverride = _ => Task.CompletedTask;
        await f.Manager.ObserveAsync(
            f.First,
            "session",
            new JsonObject
            {
                ["action"] = "update-display-name",
                ["sessionId"] = named.Id,
                ["name"] = "Release Notes",
            }
        );

        var local = await List(f, new JsonObject { ["query"] = "  RELEASE " });
        Assert.Equal("RELEASE", local["query"]!.GetValue<string>());
        Assert.Equal(1, local["total"]!.GetValue<long>());
        Assert.Equal(0, local["start"]!.GetValue<int>());
        Assert.Equal([named.Id], Ids(local));
        Assert.Null(local["nextPage"]);

        var all = await List(f, new JsonObject { ["query"] = "release", ["scope"] = "all" });
        Assert.Equal(2, all["total"]!.GetValue<long>());
        Assert.Contains(named.Id, Ids(all));
        Assert.Contains(other.Id, Ids(all));

        // Whole-string literal match: separate words do not match independently.
        var none = await List(f, new JsonObject { ["query"] = "notes release" });
        Assert.Equal(0, none["total"]!.GetValue<long>());
        Assert.Empty(Ids(none));

        var page = await List(
            f,
            new JsonObject
            {
                ["query"] = "main",
                ["start"] = 1,
                ["count"] = 1,
            }
        );
        Assert.Equal(3, page["total"]!.GetValue<long>());
        Assert.Equal(1, page["start"]!.GetValue<int>());
        Assert.Single(Ids(page));
        var next = page["nextPage"]!.GetValue<string>();
        Assert.Equal("ctl session list main --start 2 --count 1", next);
        // The hint is a command the parser reads back to the same next-page arguments.
        var hinted = CtlTestArgs.Hint(next, "session");
        Assert.Equal("""{"query":"main","start":2,"count":1}""", hinted.ToJsonString());
        var beyond = await List(f, new JsonObject { ["query"] = "main", ["start"] = 5 });
        Assert.Equal(3, beyond["total"]!.GetValue<long>());
        Assert.Empty(Ids(beyond));

        foreach (var invalid in new JsonNode?[] { "   ", new string('x', 257), 3, null })
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                List(f, new JsonObject { ["query"] = invalid })
            );
    }
}
