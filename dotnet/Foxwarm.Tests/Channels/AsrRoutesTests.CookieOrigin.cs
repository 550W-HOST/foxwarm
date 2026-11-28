using System.Net;
using System.Net.Http.Headers;

namespace Foxwarm.Tests;

public sealed partial class AsrRoutesTests
{
    [Theory]
    [InlineData(Fixture.Token)]
    [InlineData("scoped-origin-test")]
    public async Task CookieAuthorityChecksUnsafeMethodsAndWebSockets(string token)
    {
        await using var f = await Fixture.Create(config: _ => "access:\n  identities:\n    reader: {token: scoped-origin-test, surfaces: {webui: {sessions: [chat]}}}\n", prefix: true);
        f.Client.DefaultRequestHeaders.Authorization = null;
        f.Client.DefaultRequestHeaders.Add("Cookie", "foxwarm_token=" + token);
        foreach (var method in new[] { HttpMethod.Post, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete })
        {
            using var request = new HttpRequestMessage(method, "prefix/api/session-sequence");
            request.Headers.Add("Origin", "https://sibling.example");
            using var result = await f.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.Forbidden, result.StatusCode);
            Assert.Equal("Cross-origin request refused.", await result.Content.ReadAsStringAsync());
        }
        async Task<(int, string)> Handshake(string origin, string route = "prefix/api/auth/session")
        {
            // Successful probes use the role endpoint instead of opening a long-lived stream.
            using var request = new HttpRequestMessage(HttpMethod.Get, route);
            request.Headers.Add("Origin", origin);
            request.Headers.Add("Connection", "Upgrade");
            request.Headers.Add("Upgrade", "websocket");
            request.Headers.Add("Sec-WebSocket-Key", Convert.ToBase64String(new byte[16]));
            request.Headers.Add("Sec-WebSocket-Version", "13");
            using var response = await f.Client.SendAsync(request);
            return ((int)response.StatusCode, await response.Content.ReadAsStringAsync());
        }
        Assert.Equal((403, "Cross-origin request refused."), await Handshake("https://sibling.example", "prefix/api/webui/stream"));
        Assert.Equal(200, (await Handshake("https://public.example")).Item1);
        Assert.Equal(200, (await Handshake(f.Client.BaseAddress!.GetLeftPart(UriPartial.Authority))).Item1);
        f.Client.DefaultRequestHeaders.Add("Sec-Fetch-Site", "same-site");
        Assert.Equal(403, (await Handshake("https://sibling.example")).Item1);
        f.Client.DefaultRequestHeaders.Add("X-Forwarded-Host", "alias.example:8443");
        Assert.Equal(200, (await Handshake("https://alias.example:8443")).Item1);
        f.Client.DefaultRequestHeaders.Remove("X-Forwarded-Host");
        f.Client.DefaultRequestHeaders.Remove("Sec-Fetch-Site");
        f.Client.DefaultRequestHeaders.Add("Sec-Fetch-Site", "same-origin");
        Assert.Equal(403, (await Handshake("https://proxy.example")).Item1); // Configured socket origins never use Fetch Metadata.
        using (var request = new HttpRequestMessage(HttpMethod.Post, "prefix/api/session-sequence"))
        {
            request.Headers.Add("Origin", "https://proxy.example");
            request.Content = System.Net.Http.Json.JsonContent.Create(new { });
            using var response = await f.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        f.Client.DefaultRequestHeaders.Remove("Sec-Fetch-Site");
        f.Client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "invalid");
        if (token == Fixture.Token)
            Assert.Equal(403, (await Handshake("https://sibling.example")).Item1); // Authentication fell back to the administrator cookie.
        f.Client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        Assert.Equal(200, (await Handshake("https://sibling.example")).Item1);
        f.Client.DefaultRequestHeaders.Authorization = null;
        using var noOrigin = await f.Client.GetAsync("prefix/api/auth/session");
        Assert.Equal(HttpStatusCode.OK, noOrigin.StatusCode);
    }
}
