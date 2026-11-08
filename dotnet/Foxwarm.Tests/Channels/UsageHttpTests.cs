using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class UsageHttpTests
{
    [Fact]
    public async Task Administrators_query_installation_usage_while_scoped_identities_are_denied()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            """
            access:
              identities:
                reader:
                  token: synthetic-usage-reader
                  surfaces:
                    webui: {sessions: [lead]}
            """
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            """
            default: local/wire
            providers:
              local:
                providerType: openai-responses
                baseUrl: http://127.0.0.1:1/v1
                models: [wire]
            """
        );
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(data, temp.Path, environment: _ => null)
        );
        var settings = await HttpServerSettings.CaptureDesktopAsync(data);
        await using var host = await MainHost.CreateAsync([], config, settings);
        await host.StartAsync();
        using var admin = new HttpClient { BaseAddress = new Uri(settings.Address.BaseUrl) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        using var scoped = new HttpClient { BaseAddress = admin.BaseAddress };
        scoped.DefaultRequestHeaders.Authorization = new("Bearer", "synthetic-usage-reader");
        var created = await admin.PostAsJsonAsync(
            "api/sessions",
            new { agentId = "main", sessionId = "lead" }
        );
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());

        const string query = "api/usage?boundaries=0,86400000,9999999999999&groupBy=agent";
        Assert.Equal(HttpStatusCode.Forbidden, (await scoped.GetAsync(query)).StatusCode);

        var response = await admin.GetAsync(query);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, text);
        var body = JsonNode.Parse(text)!.AsObject();
        Assert.Equal(0, body["total"]!["requests"]!.GetValue<long>());
        Assert.Null(body["total"]!["cost"]);
        Assert.Equal(2, body["buckets"]!.AsArray().Count);
        Assert.Empty(body["groups"]!.AsArray());
        Assert.NotNull(body["coverage"]);

        var tooMany = string.Join(",", Enumerable.Range(1, 402));
        foreach (
            var invalid in new[]
            {
                "api/usage",
                "api/usage?boundaries=5",
                "api/usage?boundaries=5,5",
                "api/usage?boundaries=-1,5",
                "api/usage?boundaries=1,x",
                $"api/usage?boundaries={tooMany}",
                "api/usage?boundaries=1,2&groupBy=result",
                "api/usage?boundaries=1,2&limit=0",
                "api/usage?boundaries=1,2&agent=",
                "api/usage?boundaries=1,2&from=1",
                "api/usage?boundaries=1,2&boundaries=3,4",
            }
        )
        {
            var rejected = await admin.GetAsync(invalid);
            Assert.True(
                rejected.StatusCode == HttpStatusCode.BadRequest,
                $"{invalid}: {rejected.StatusCode}"
            );
            Assert.Equal(
                "USAGE_INVALID_QUERY",
                JsonNode.Parse(await rejected.Content.ReadAsStringAsync())!["code"]!.GetValue<string>()
            );
        }
    }
}
