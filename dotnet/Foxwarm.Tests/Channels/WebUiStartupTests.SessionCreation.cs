using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed partial class WebUiStartupTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Session_creation_preserves_requested_identity_order_and_controls_for_both_body_framings(
        bool chunked
    )
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(
            h.ConfigPath,
            $"bot: {{httpPort: {h.Port}}}\nvector: false\naccess:\n  identities:\n    viewer:\n      token: synthetic-framing-viewer\n      surfaces:\n        webui: {{sessions: [framing/main]}}\n"
        );
        h.Start();
        await h.Ready();
        using var agent = await h.Client.PostAsJsonAsync(
            "/api/agents",
            new { agentId = "framing" }
        );
        Assert.Equal(HttpStatusCode.Created, agent.StatusCode);

        async Task<string[]> Roots()
        {
            var page = await h.Client.GetFromJsonAsync<JsonObject>(
                "/api/session-list/sidebar?limit=50"
            );
            return page!["sessions"]!
                .AsArray()
                .Select(row => row!["id"]!.GetValue<string>())
                .ToArray();
        }

        // Top-level Sessions of an Agent with a main Session are shown under that host.
        async Task<string[]> Under(string? host)
        {
            if (host is null)
                return await Roots();
            using var response = await h.Client.PostAsJsonAsync(
                "/api/session-list/children",
                new { limit = 20, parents = new[] { new { parentSessionId = host } } }
            );
            var page = await response.Content.ReadFromJsonAsync<JsonObject>();
            return page!["children"]![0]!["sessions"]!
                .AsArray()
                .Select(row => row!["id"]!.GetValue<string>())
                .ToArray();
        }

        async Task<string[]> Tree()
        {
            var roots = await Roots();
            var tree = new List<string>(roots);
            foreach (var root in roots)
                tree.AddRange((await Under(root)).Select(child => root + ">" + child));
            return tree.ToArray();
        }

        async Task<HttpResponseMessage> Post(HttpContent? content, HttpClient? client = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/sessions")
            {
                Content = content,
            };
            if (chunked && content is not null)
                request.Headers.TransferEncodingChunked = true;
            return await (client ?? h.Client).SendAsync(request);
        }

        var previous = await Under("framing/main");
        var identity = new { agentId = "framing", sessionId = "requested" };
        using var content = chunked
            ? (HttpContent)JsonContent.Create(identity)
            : new StringContent(
                System.Text.Json.JsonSerializer.Serialize(identity),
                Encoding.UTF8,
                "application/json"
            );
        if (chunked)
            Assert.Null(content.Headers.ContentLength);
        // Do not force framing for this request: the real JsonContent caller chooses chunked HTTP/1.1.
        using var createRequest = new HttpRequestMessage(HttpMethod.Post, "/api/sessions")
        {
            Content = content,
        };
        using var created = await h.Client.SendAsync(createRequest);
        Assert.Equal(chunked, createRequest.Headers.TransferEncodingChunked == true);
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var receipt = await created.Content.ReadFromJsonAsync<JsonObject>();
        Assert.True(
            JsonNode.DeepEquals(
                new JsonObject { ["success"] = true, ["sessionId"] = "framing/requested" },
                receipt
            ),
            receipt?.ToJsonString()
        );
        Assert.Equal(new[] { "framing/requested" }.Concat(previous), await Under("framing/main"));
        var catalog = await h.Client.GetFromJsonAsync<JsonObject>("/api/sessions");
        Assert.Contains(
            catalog!["sessions"]!.AsArray(),
            row => row!["id"]!.GetValue<string>() == "framing/requested"
        );
        Assert.Equal(
            HttpStatusCode.OK,
            (await h.Client.GetAsync("/api/sessions/framing%2Frequested/history")).StatusCode
        );

        // Source accepts no body, a zero-byte JSON stream and an empty object as ordinary creation.
        // Without a main Session, two top-level main-Agent rows form the virtual Agent group.
        foreach (var seed in new[] { "seed-a", "seed-b" })
        {
            using var seeded = await Post(
                JsonContent.Create(new { agentId = "main", sessionId = seed })
            );
            Assert.Equal(HttpStatusCode.OK, seeded.StatusCode);
        }
        Assert.Contains("//agent/main", await Roots());
        const string mainHost = "//agent/main";
        foreach (var text in new string?[] { null, "", "{}" })
        {
            previous = await Under(mainHost);
            using var response = await Post(
                text is null ? null : new StringContent(text, Encoding.UTF8, "application/json")
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var generated = (await response.Content.ReadFromJsonAsync<JsonObject>())![
                "sessionId"
            ]!.GetValue<string>();
            Assert.Matches(@"^\d{4}_[a-z0-9]{5}$", generated);
            Assert.DoesNotContain(generated, previous);
            Assert.Equal(new[] { generated }.Concat(previous), await Under(mainHost));
        }

        previous = await Under("framing/main");
        using (var response = await Post(JsonContent.Create(new { agentId = "framing" })))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var generated = (await response.Content.ReadFromJsonAsync<JsonObject>())![
                "sessionId"
            ]!.GetValue<string>();
            Assert.Matches(@"^framing/\d{4}_[a-z0-9]{5}$", generated);
            Assert.Equal(new[] { generated }.Concat(previous), await Under("framing/main"));
        }

        previous = await Tree();
        foreach (var text in new[] { "{", " \n ", "null", "{\"agentId\":17}" })
        {
            using var response = await Post(
                new StringContent(text, Encoding.UTF8, "application/json")
            );
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.False(
                string.IsNullOrEmpty(
                    (await response.Content.ReadFromJsonAsync<JsonObject>())![
                        "error"
                    ]!.GetValue<string>()
                )
            );
            Assert.Equal(previous, await Tree());
        }
        using var denied = new HttpClient(new HttpClientHandler { UseCookies = false })
        {
            BaseAddress = h.Client.BaseAddress,
        };
        foreach (var token in new string?[] { null, "synthetic-framing-viewer" })
        {
            denied.DefaultRequestHeaders.Authorization = token is null
                ? null
                : new("Bearer", token);
            using var response = await Post(
                JsonContent.Create(new { agentId = "framing", sessionId = "denied" }),
                denied
            );
            Assert.Equal(
                token is null ? HttpStatusCode.Unauthorized : HttpStatusCode.Forbidden,
                response.StatusCode
            );
            Assert.Equal(previous, await Tree());
        }
        // Virtual groups merge into root paging by sort key and lead focus paths.
        foreach (var mode in new[] { "default", "time" })
        {
            var paged = new List<string>();
            string? cursor = null;
            do
            {
                var page = await h.Client.GetFromJsonAsync<JsonObject>(
                    $"/api/session-list/sidebar?mode={mode}&limit=1"
                        + (cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(cursor))
                );
                paged.AddRange(
                    page!["sessions"]!.AsArray().Select(row => row!["id"]!.GetValue<string>())
                );
                cursor = page["nextCursor"]?.GetValue<string>();
            } while (cursor is not null);
            var full = await h.Client.GetFromJsonAsync<JsonObject>(
                $"/api/session-list/sidebar?mode={mode}&limit=50"
            );
            Assert.Equal(
                full!["sessions"]!.AsArray().Select(row => row!["id"]!.GetValue<string>()),
                paged
            );
            Assert.Single(paged, id => id == "//agent/main");
        }
        var focused = await h.Client.GetFromJsonAsync<JsonObject>(
            "/api/session-list/sidebar?limit=50&focusSessionId=seed-a"
        );
        Assert.Equal(
            ["//agent/main", "seed-a"],
            focused!["presentationPaths"]!["seed-a"]!.AsArray().Select(id => id!.GetValue<string>())
        );
        var groupRow = focused["pathContext"]!
            .AsArray()
            .Single(item => item!["session"]!["id"]!.GetValue<string>() == "//agent/main")![
            "session"
        ]!;
        Assert.Equal("main", groupRow["presentationGroup"]!["agent"]!.GetValue<string>());
        Assert.Contains(
            "seed-a",
            focused["forcedChildren"]!["//agent/main"]!
                .AsArray()
                .Select(id => id!.GetValue<string>())
        );

        previous = await Roots();
        using (
            var response = await h.Client.PostAsJsonAsync("/api/agents", new { agentId = "newest" })
        )
        {
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
            Assert.Equal(new[] { "newest/main" }.Concat(previous), await Roots());
        }
        previous = await Tree();
        using (var duplicate = await Post(JsonContent.Create(identity)))
            Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        using (
            var invalid = await Post(
                JsonContent.Create(new { agentId = "framing", sessionId = " requested " })
            )
        )
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Equal(previous, await Tree());
        using (
            var invalid = await h.Client.PostAsJsonAsync(
                "/api/sessions/framing%2Frequested/fork",
                new { suffix = "" }
            )
        )
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using (
            var forked = await h.Client.PostAsJsonAsync(
                "/api/sessions/framing%2Frequested/fork",
                new { }
            )
        )
        {
            Assert.Equal(HttpStatusCode.OK, forked.StatusCode);
            Assert.Equal(
                "framing/requested_fork",
                (await forked.Content.ReadFromJsonAsync<JsonObject>())![
                    "newSessionId"
                ]!.GetValue<string>()
            );
        }
        await h.Stop();
    }

    [Fact]
    public async Task Session_creation_with_a_parent_attaches_a_fresh_user_child()
    {
        await using var h = new Host();
        await File.WriteAllTextAsync(h.TokenPath, h.Token);
        await File.WriteAllTextAsync(
            h.ConfigPath,
            $"bot: {{httpPort: {h.Port}}}\nvector: false\naccess:\n  identities:\n    viewer:\n      token: synthetic-child-viewer\n      surfaces:\n        webui: {{sessions: [kids/main]}}\n"
        );
        h.Start();
        await h.Ready();
        using (var agent = await h.Client.PostAsJsonAsync("/api/agents", new { agentId = "kids" }))
            Assert.Equal(HttpStatusCode.Created, agent.StatusCode);

        using (
            var created = await h.Client.PostAsJsonAsync(
                "/api/sessions",
                new
                {
                    agentId = "kids",
                    sessionId = "picked",
                    parentSessionId = "kids/main",
                }
            )
        )
        {
            Assert.Equal(HttpStatusCode.OK, created.StatusCode);
            Assert.True(
                JsonNode.DeepEquals(
                    new JsonObject
                    {
                        ["success"] = true,
                        ["sessionId"] = "kids/picked",
                        ["parentSessionId"] = "kids/main",
                    },
                    await created.Content.ReadFromJsonAsync<JsonObject>()
                )
            );
        }
        var exact = await h.Client.PostAsJsonAsync(
            "/api/session-list/by-id",
            new { ids = new[] { "kids/picked" } }
        );
        var row = (await exact.Content.ReadFromJsonAsync<JsonObject>())!["results"]![0]![
            "session"
        ]!;
        Assert.Equal("kids/main", row["parentSessionId"]!.GetValue<string>());
        Assert.Equal("kids/main", row["sidebarParentId"]!.GetValue<string>());
        var history = await h.Client.GetFromJsonAsync<JsonObject>(
            "/api/sessions/kids%2Fpicked/history"
        );
        var text = history!.ToJsonString();
        Assert.Contains("user-child-created", text);
        Assert.Contains("does not itself assign work or require a completion report", text);

        // Missing or invalid parents create nothing.
        using (
            var missing = await h.Client.PostAsJsonAsync(
                "/api/sessions",
                new
                {
                    agentId = "kids",
                    sessionId = "orphan",
                    parentSessionId = "kids/none",
                }
            )
        )
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        using (
            var invalid = await h.Client.PostAsync(
                "/api/sessions",
                new StringContent(
                    "{\"agentId\":\"kids\",\"parentSessionId\":7}",
                    Encoding.UTF8,
                    "application/json"
                )
            )
        )
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        // A scoped identity cannot create Sessions, including children of its own Session.
        using var scoped = new HttpClient(new HttpClientHandler { UseCookies = false })
        {
            BaseAddress = h.Client.BaseAddress,
        };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-child-viewer");
        using (
            var denied = await scoped.PostAsJsonAsync(
                "/api/sessions",
                new
                {
                    agentId = "kids",
                    sessionId = "scoped",
                    parentSessionId = "kids/main",
                }
            )
        )
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        var all = (await h.Client.GetFromJsonAsync<JsonObject>("/api/sessions"))!["sessions"]!
            .AsArray()
            .Select(item => item!["id"]!.GetValue<string>())
            .ToArray();
        Assert.DoesNotContain("kids/orphan", all);
        Assert.DoesNotContain("kids/scoped", all);
        await h.Stop();
    }
}
