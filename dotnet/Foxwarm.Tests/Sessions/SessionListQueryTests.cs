using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class SessionListQueryTests
{
    private static async Task<string> List(OutboundMcpFixture f, JsonObject args)
    {
        args["action"] = "list";
        var result = await f.Manager.ObserveAsync(f.First, "session", args);
        return result["output"]!.GetValue<string>();
    }

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
        Assert.Contains("Found 1 session(s) matching `RELEASE`. Showing 1-1.", local);
        Assert.Contains(named.Id, local);
        Assert.DoesNotContain(other.Id, local);

        var all = await List(f, new JsonObject { ["query"] = "release", ["scope"] = "all" });
        Assert.Contains("Found 2 session(s) matching `release`.", all);
        Assert.Contains(named.Id, all);
        Assert.Contains(other.Id, all);

        // Whole-string literal match: separate words do not match independently.
        Assert.Contains(
            "No sessions found matching `notes release`.",
            await List(f, new JsonObject { ["query"] = "notes release" })
        );

        var page = await List(
            f,
            new JsonObject
            {
                ["query"] = "main",
                ["start"] = 1,
                ["count"] = 1,
            }
        );
        Assert.Contains("Found 3 session(s) matching `main`. Showing 2-2.", page);
        Assert.Contains("Use `start: 2` to see the next page.", page);
        Assert.Contains(
            "No sessions found in the requested range. Total sessions matching `main`: 3.",
            await List(f, new JsonObject { ["query"] = "main", ["start"] = 5 })
        );

        foreach (var invalid in new JsonNode?[] { "   ", new string('x', 257), 3, null })
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                List(f, new JsonObject { ["query"] = invalid })
            );
    }
}
