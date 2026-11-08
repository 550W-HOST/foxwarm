using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Sidebar_groups_page_pinned_rows_apart_and_put_each_agent_main_first()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(h.ConfigPath, "vector: false\n");
        h.Start();
        await h.Ready();
        async Task Create(object body)
        {
            using var response = await h.Client.PostAsJsonAsync("/api/sessions", body);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        using (var agent = await h.Client.PostAsJsonAsync("/api/agents", new { agentId = "kids" }))
            Assert.Equal(HttpStatusCode.Created, agent.StatusCode);
        await Create(new { agentId = "kids", sessionId = "k1" });
        await Create(new { agentId = "kids", sessionId = "k2" });
        await Create(new { agentId = "kids", sessionId = "k3" });
        // A main-Agent child of a kids row stays under its real parent.
        await Create(
            new
            {
                agentId = "main",
                sessionId = "visitor",
                parentSessionId = "kids/k1",
            }
        );
        await Create(new { agentId = "main", sessionId = "loose" });
        await Create(new { agentId = "main", sessionId = "starred" });
        using (
            var pin = await h.Client.PostAsJsonAsync(
                "/api/sessions/starred/pin",
                new { pinned = true }
            )
        )
            Assert.True(pin.IsSuccessStatusCode, await pin.Content.ReadAsStringAsync());

        static string[] Ids(JsonNode? rows) =>
            rows!.AsArray().Select(row => row!["id"]!.GetValue<string>()).ToArray();

        var sidebar = await h.Client.GetFromJsonAsync<JsonObject>(
            "/api/session-list/sidebar?mode=time&group=agent&focusSessionId=visitor"
        );
        Assert.Equal(["starred"], Ids(sidebar!["sessions"]));
        var groups = sidebar["groups"]!.AsArray().Select(group => group!.AsObject()).ToArray();
        Assert.Equal(["main", "kids"], groups.Select(group => group["key"]!.GetValue<string>()));
        Assert.Equal(4, groups[1]["count"]!.GetValue<int>());
        // The focus path is shown in the group of its top-level row.
        Assert.Equal("kids", sidebar["presentationGroups"]!["kids/k1"]!.GetValue<string>());

        async Task<JsonObject> Pages(object body)
        {
            using var response = await h.Client.PostAsJsonAsync(
                "/api/session-list/group-pages",
                body
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        }
        var first = await Pages(
            new
            {
                group = "agent",
                mode = "time",
                limit = 2,
                groups = new[] { new { key = "kids" } },
            }
        );
        var kids = first["groups"]![0]!;
        // k1 is last by its own time but holds the newest descendant (visitor), so it leads.
        Assert.Equal(["kids/main", "kids/k1"], Ids(kids["sessions"]));
        Assert.Equal(4, kids["total"]!.GetValue<int>());
        var rest = await Pages(
            new
            {
                group = "agent",
                mode = "time",
                limit = 5,
                groups = new[]
                {
                    new { key = "kids", cursor = kids["nextCursor"]!.GetValue<string>() },
                },
            }
        );
        Assert.Equal(["kids/k3", "kids/k2"], Ids(rest["groups"]![0]!["sessions"]));
        Assert.Null(rest["groups"]![0]!["nextCursor"]);
        // A one-row first page holds the main alone and continues from the first other row.
        var single = await Pages(
            new
            {
                group = "agent",
                mode = "default",
                limit = 1,
                groups = new[] { new { key = "kids" } },
            }
        );
        Assert.Equal(["kids/main"], Ids(single["groups"]![0]!["sessions"]));
        var after = await Pages(
            new
            {
                group = "agent",
                mode = "default",
                limit = 10,
                groups = new[]
                {
                    new
                    {
                        key = "kids",
                        cursor = single["groups"]![0]!["nextCursor"]!.GetValue<string>(),
                    },
                },
            }
        );
        Assert.Equal(3, Ids(after["groups"]![0]!["sessions"]).Length);
        Assert.DoesNotContain("kids/main", Ids(after["groups"]![0]!["sessions"]));

        // Flat groups hold every unpinned Session of the group, still main first.
        var flat = await Pages(
            new
            {
                group = "agent",
                mode = "flat-time",
                groups = new[] { new { key = "kids" }, new { key = "main" } },
            }
        );
        Assert.Equal("kids/main", Ids(flat["groups"]![0]!["sessions"])[0]);
        var flatMain = Ids(flat["groups"]![1]!["sessions"]);
        Assert.Contains("visitor", flatMain);
        Assert.DoesNotContain("starred", flatMain);

        // Node groups name master and report its state.
        var nodes = await h.Client.GetFromJsonAsync<JsonObject>(
            "/api/session-list/sidebar?group=node"
        );
        var master = nodes!["groups"]![0]!;
        Assert.Equal("master", master["key"]!.GetValue<string>());
        Assert.Equal("master", master["label"]!.GetValue<string>());
        Assert.True(master["online"]!.GetValue<bool>());

        // Exact rows carry the group they are shown in: their top-level row's in tree modes.
        async Task<JsonObject> Exact(string mode)
        {
            using var response = await h.Client.PostAsJsonAsync(
                "/api/session-list/by-id",
                new
                {
                    ids = new[] { "visitor" },
                    group = "agent",
                    mode,
                }
            );
            return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        }
        Assert.Equal(
            "kids",
            (await Exact("time"))["presentationGroups"]!["visitor"]!.GetValue<string>()
        );
        Assert.Equal(
            "main",
            (await Exact("flat-time"))["presentationGroups"]!["visitor"]!.GetValue<string>()
        );

        using (var invalid = await h.Client.GetAsync("/api/session-list/sidebar?group=parent"))
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using (
            var invalid = await h.Client.PostAsJsonAsync(
                "/api/session-list/group-pages",
                new { mode = "time", groups = Array.Empty<object>() }
            )
        )
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        await h.Stop();
    }
}
