using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class WebUiHistoryAvailabilityTests
{
    [Fact]
    public async Task Disabled_search_is_reported_without_disabling_exact_Archive_references()
    {
        await using var f = await InboundMcpFixture.CreateAsync(webUiEnabled: true);
        f.Http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            InboundMcpFixture.Admin
        );
        var api = f.Url.Replace("/mcp", "/api");
        var status = (await f.Http.GetFromJsonAsync<JsonObject>(api + "/setup/status"))!;
        Assert.False(status["capabilities"]!["historySearch"]!["available"]!.GetValue<bool>());
        Assert.NotEmpty(status["capabilities"]!["historySearch"]!["reason"]!.GetValue<string>());
        using var search = await f.Http.GetAsync(api + "/history/search?query=archived");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, search.StatusCode);
        await ForkClearLifecycleTests.AppendAsync(
            f.Target,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "archived exact reference" }),
            }
        );
        var exact = (
            await f.Http.GetFromJsonAsync<JsonObject>(
                api + "/history/window?sessionId=target&target=msg%231"
            )
        )!;
        Assert.Equal(
            "archived exact reference",
            exact["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>()
        );
    }
}
