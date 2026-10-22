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

        var previous = await Roots();
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
        Assert.Equal(new[] { "framing/requested" }.Concat(previous), await Roots());
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
        foreach (var text in new string?[] { null, "", "{}" })
        {
            previous = await Roots();
            using var response = await Post(
                text is null ? null : new StringContent(text, Encoding.UTF8, "application/json")
            );
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var generated = (await response.Content.ReadFromJsonAsync<JsonObject>())![
                "sessionId"
            ]!.GetValue<string>();
            Assert.Matches(@"^\d{4}_[a-z0-9]{5}$", generated);
            Assert.DoesNotContain(generated, previous);
            Assert.Equal(new[] { generated }.Concat(previous), await Roots());
        }

        previous = await Roots();
        using (var response = await Post(JsonContent.Create(new { agentId = "framing" })))
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var generated = (await response.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]!.GetValue<string>();
            Assert.Matches(@"^framing/\d{4}_[a-z0-9]{5}$", generated);
            Assert.Equal(new[] { generated }.Concat(previous), await Roots());
        }

        previous = await Roots();
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
            Assert.Equal(previous, await Roots());
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
            Assert.Equal(previous, await Roots());
        }
        previous = await Roots();
        using (var response = await h.Client.PostAsJsonAsync("/api/agents", new { agentId = "newest" }))
        {
            Assert.Equal(HttpStatusCode.Created, response.StatusCode);
            Assert.Equal(new[] { "newest/main" }.Concat(previous), await Roots());
        }
        previous = await Roots();
        using (var duplicate = await Post(JsonContent.Create(identity)))
            Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        using (var invalid = await Post(JsonContent.Create(new { agentId = "framing", sessionId = " requested " })))
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Equal(previous, await Roots());
        using (var invalid = await h.Client.PostAsJsonAsync("/api/sessions/framing%2Frequested/fork", new { suffix = "" }))
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using (var forked = await h.Client.PostAsJsonAsync("/api/sessions/framing%2Frequested/fork", new { }))
        {
            Assert.Equal(HttpStatusCode.OK, forked.StatusCode);
            Assert.Equal("framing/requested_fork", (await forked.Content.ReadFromJsonAsync<JsonObject>())!["newSessionId"]!.GetValue<string>());
        }
        await h.Stop();
    }
}
