using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class EmbeddedHostTests
{
    [Fact]
    public async Task Desktop_rejects_a_blank_persisted_token_without_replacing_it()
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        var file = Path.Combine(state, "token");
        await File.WriteAllTextAsync(file, " \n");
        await Assert.ThrowsAsync<InvalidDataException>(() => HttpServerSettings.CaptureDesktopAsync(temp.Path));
        Assert.Equal(" \n", await File.ReadAllTextAsync(file));
    }

    [Fact]
    public async Task Desktop_host_owns_an_ephemeral_loopback_listener_and_retains_auth_and_state()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        var dist = Path.Combine(temp.Path, "dist");
        Directory.CreateDirectory(work);
        Directory.CreateDirectory(Path.Combine(dist, "assets"));
        await File.WriteAllTextAsync(Path.Combine(dist, "index.html"), "<html><head></head><body>embedded fixture</body></html>");
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        Assert.Equal(0, settings.Port);
        Assert.Equal("127.0.0.1", settings.BindAddress);
        var token = settings.Token;
        var first = await MainHost.CreateAsync([], data, work, new ModelConfiguration(data), settings, dist);
        Uri endpoint;
        await using (first)
        {
            await first.App.StartAsync();
            endpoint = new Uri(settings.Address.BaseUrl);
            Assert.Equal("127.0.0.1", endpoint.Host);
            Assert.NotEqual(0, endpoint.Port);
            Assert.Equal(endpoint.GetLeftPart(UriPartial.Authority), first.App.Urls.Single());
            using var handler = new HttpClientHandler { CookieContainer = new CookieContainer(), UseProxy = false };
            using var client = new HttpClient(handler) { BaseAddress = endpoint };
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("api/auth/session")).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("api/auth", new { token = "wrong" })).StatusCode);
            Assert.True((await client.PostAsJsonAsync("api/auth", new { token })).IsSuccessStatusCode);
            Assert.Equal("admin", (await client.GetFromJsonAsync<JsonObject>("api/auth/session"))!["role"]!.GetValue<string>());
            Assert.Contains("embedded fixture", await client.GetStringAsync("/"));
            var config = await client.PostAsJsonAsync("api/setup/config", new { yaml = "llm:\n  maxOutput: 731\n" });
            config.EnsureSuccessStatusCode();
        }
        using (var stopped = new HttpClient { Timeout = TimeSpan.FromSeconds(2) })
            await Assert.ThrowsAsync<HttpRequestException>(() => stopped.GetAsync(endpoint));
        var restarted = await HttpServerSettings.CaptureDesktopAsync(data);
        Assert.Equal(token, restarted.Token);
        var configuration = new ModelConfiguration(data);
        Assert.Equal(731, configuration.MaxOutput);
        await using var second = await MainHost.CreateAsync([], data, work, configuration, restarted, dist);
        await second.App.StartAsync();
        using var authorized = new HttpClient { BaseAddress = new Uri(restarted.Address.BaseUrl) };
        authorized.DefaultRequestHeaders.Authorization = new("Bearer", token);
        Assert.True((await authorized.GetAsync("health")).IsSuccessStatusCode);
    }
}
