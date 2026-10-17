using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class EmbeddedHostTests
{
    [Fact]
    public async Task Shared_host_closes_live_Session_streams_after_owner_settlement_before_HTTP_stop()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync(
            [],
            data,
            work,
            new ModelConfiguration(data),
            settings,
            null
        );
        await host.App.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var created = await client.PostAsJsonAsync(
            "api/sessions",
            new { agentId = "main", sessionId = "stream-owner" }
        );
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonObject>())![
            "sessionId"
        ]!.GetValue<string>();
        using var stream = await client.GetAsync(
            "api/sessions/" + Uri.EscapeDataString(id) + "/stream",
            HttpCompletionOption.ResponseHeadersRead
        );
        stream.EnsureSuccessStatusCode();
        Assert.Equal("text/event-stream", stream.Content.Headers.ContentType!.MediaType);
        await host.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        var body = await stream.Content.ReadAsStringAsync().WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("connected", body);
    }

    [Fact]
    public async Task Occupied_remembered_port_falls_back_during_the_same_host_start()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var occupied = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        occupied.Start();
        try
        {
            var occupiedPort = ((IPEndPoint)occupied.LocalEndpoint).Port;
            var settings = await HttpServerSettings.CaptureDesktopAsync(data);
            await File.WriteAllTextAsync(
                Path.Combine(data, "state", "desktop-port"),
                occupiedPort.ToString()
            );
            settings = await HttpServerSettings.CaptureDesktopAsync(data);
            Assert.Equal(occupiedPort, settings.Port);
            await using var host = await MainHost.CreateAsync(
                [],
                data,
                work,
                new ModelConfiguration(data),
                settings,
                null
            );
            await host.App.StartAsync();
            var actual = new Uri(settings.Address.BaseUrl);
            Assert.NotEqual(occupiedPort, actual.Port);
            Assert.False(occupied.Pending());
            using var client = new HttpClient { BaseAddress = actual };
            client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
            Assert.True((await client.GetAsync("health")).IsSuccessStatusCode);
        }
        finally
        {
            occupied.Stop();
        }
    }

    [Fact]
    public async Task Desktop_rejects_a_blank_persisted_token_without_replacing_it()
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        var file = Path.Combine(state, "token");
        await File.WriteAllTextAsync(file, " \n");
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            HttpServerSettings.CaptureDesktopAsync(temp.Path)
        );
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
        await File.WriteAllTextAsync(
            Path.Combine(dist, "index.html"),
            "<html><head></head><body>embedded fixture</body></html>"
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        Assert.Equal(0, settings.Port);
        Assert.Equal("127.0.0.1", settings.BindAddress);
        var token = settings.Token;
        var first = await MainHost.CreateAsync(
            [],
            data,
            work,
            new ModelConfiguration(data),
            settings,
            dist
        );
        Uri endpoint;
        await using (first)
        {
            await first.App.StartAsync();
            endpoint = new Uri(settings.Address.BaseUrl);
            Assert.Equal("127.0.0.1", endpoint.Host);
            Assert.NotEqual(0, endpoint.Port);
            Assert.Equal(endpoint.GetLeftPart(UriPartial.Authority), first.App.Urls.Single());
            using var handler = new HttpClientHandler
            {
                CookieContainer = new CookieContainer(),
                UseProxy = false,
            };
            using var client = new HttpClient(handler) { BaseAddress = endpoint };
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await client.GetAsync("api/auth/session")).StatusCode
            );
            Assert.Equal(
                HttpStatusCode.Unauthorized,
                (await client.PostAsJsonAsync("api/auth", new { token = "wrong" })).StatusCode
            );
            Assert.True(
                (await client.PostAsJsonAsync("api/auth", new { token })).IsSuccessStatusCode
            );
            Assert.Equal(
                "admin",
                (await client.GetFromJsonAsync<JsonObject>("api/auth/session"))![
                    "role"
                ]!.GetValue<string>()
            );
            Assert.Contains("embedded fixture", await client.GetStringAsync("/"));
            var config = await client.PostAsJsonAsync(
                "api/setup/config",
                new { yaml = "llm:\n  maxOutput: 731\n" }
            );
            config.EnsureSuccessStatusCode();
        }
        using (var stopped = new HttpClient { Timeout = TimeSpan.FromSeconds(2) })
            await Assert.ThrowsAsync<HttpRequestException>(() => stopped.GetAsync(endpoint));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "desktop-port"),
            endpoint.Port.ToString()
        );
        var restarted = await HttpServerSettings.CaptureDesktopAsync(data);
        Assert.Equal(token, restarted.Token);
        var configuration = new ModelConfiguration(data);
        Assert.Equal(731, configuration.MaxOutput);
        await using var second = await MainHost.CreateAsync(
            [],
            data,
            work,
            configuration,
            restarted,
            dist
        );
        await second.App.StartAsync();
        Assert.Equal(endpoint.AbsoluteUri, restarted.Address.BaseUrl);
        using var authorized = new HttpClient { BaseAddress = new Uri(restarted.Address.BaseUrl) };
        authorized.DefaultRequestHeaders.Authorization = new("Bearer", token);
        Assert.True((await authorized.GetAsync("health")).IsSuccessStatusCode);
    }
}
