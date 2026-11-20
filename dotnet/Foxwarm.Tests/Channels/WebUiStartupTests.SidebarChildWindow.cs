using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Fact]
    public async Task Sidebar_child_windows_follow_recent_activity_on_the_sidebar_group_and_children_routes()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.AppendAllTextAsync(h.ConfigPath, "vector: false\n");
        h.Start();
        await h.Ready();
        async Task Create(string id, string? parent = null)
        {
            using var response = await h.Client.PostAsJsonAsync(
                "/api/sessions",
                parent is null
                    ? (object)new { agentId = "main", sessionId = id }
                    : new
                    {
                        agentId = "main",
                        sessionId = id,
                        parentSessionId = parent,
                    }
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        // New Sessions are active now, so every child counts as recent.
        foreach (var (parent, children) in new[] { ("one", 1), ("three", 3), ("seven", 7) })
        {
            await Create(parent);
            for (var index = 0; index < children; index++)
                await Create($"{parent}-c{index}", parent);
        }

        static string[] Ids(JsonNode? rows) =>
            rows!.AsArray().Select(row => row!["id"]!.GetValue<string>()).ToArray();

        static Dictionary<string, JsonNode> Previews(JsonObject payload) =>
            payload["children"]!
                .AsArray()
                .ToDictionary(group => group!["parentSessionId"]!.GetValue<string>(), group => group!);

        var fixedWindow = Previews(
            (await h.Client.GetFromJsonAsync<JsonObject>("/api/session-list/sidebar?mode=time"))!
        );
        Assert.Equal(5, Ids(fixedWindow["seven"]["sessions"]).Length);
        Assert.Equal(3, Ids(fixedWindow["three"]["sessions"]).Length);

        foreach (var mode in new[] { "time", "default" })
        {
            var window = Previews(
                (
                    await h.Client.GetFromJsonAsync<JsonObject>(
                        $"/api/session-list/sidebar?mode={mode}&childWindow=recent"
                    )
                )!
            );
            Assert.Equal(1, Ids(window["one"]["sessions"]).Length);
            Assert.Equal(3, Ids(window["three"]["sessions"]).Length);
            Assert.Equal(5, Ids(window["seven"]["sessions"]).Length);
            Assert.Equal(7, window["seven"]["total"]!.GetValue<int>());
        }

        async Task<JsonObject> Children(object parents)
        {
            using var response = await h.Client.PostAsJsonAsync(
                "/api/session-list/children",
                new
                {
                    mode = "time",
                    limit = 20,
                    parents,
                }
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return (await response.Content.ReadFromJsonAsync<JsonObject>())!;
        }
        var windowed = Previews(
            await Children(
                new object[]
                {
                    new { parentSessionId = "three", window = "recent" },
                    new { parentSessionId = "seven", window = "recent" },
                    new { parentSessionId = "one" },
                }
            )
        );
        Assert.Equal(3, Ids(windowed["three"]["sessions"]).Length);
        Assert.Equal(5, Ids(windowed["seven"]["sessions"]).Length);
        Assert.Equal(1, Ids(windowed["one"]["sessions"]).Length);
        var sevenCursor = windowed["seven"]["nextCursor"]!.GetValue<string>();

        // A cursor request is sized by the request limit, not by the window.
        var rest = Previews(
            await Children(
                new object[]
                {
                    new
                    {
                        parentSessionId = "seven",
                        cursor = sevenCursor,
                        window = "recent",
                    },
                }
            )
        );
        Assert.Equal(2, Ids(rest["seven"]["sessions"]).Length);
        Assert.Null(rest["seven"]["nextCursor"]);

        // Group previews follow the same rule.
        using var grouped = await h.Client.PostAsJsonAsync(
            "/api/session-list/group-pages",
            new
            {
                group = "agent",
                mode = "time",
                limit = 20,
                childWindow = "recent",
                groups = new[] { new { key = "main" } },
            }
        );
        Assert.Equal(HttpStatusCode.OK, grouped.StatusCode);
        var preview = Previews((await grouped.Content.ReadFromJsonAsync<JsonObject>())!);
        Assert.Equal(5, Ids(preview["seven"]["sessions"]).Length);
        Assert.Equal(3, Ids(preview["three"]["sessions"]).Length);

        using var invalid = await h.Client.GetAsync(
            "/api/session-list/sidebar?mode=time&childWindow=all"
        );
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
    }
}
