using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class WebUiMessageTransportVectorTests
{
    [Fact]
    public async Task Real_Vector_history_search_projects_each_display_message_without_changing_Archive()
    {
        await using var f = await VectorFixture.CreateAsync();
        string canonical;
        await using (var seed = await f.ManagerAsync(lexical: true))
        {
            var owner = await seed.CreateNamedAsync("main", "payload-search", null, null);
            var message = WebUiMessageTransportTests.Message();
            message["parts"]!
                .AsArray()
                .Add(new JsonObject { ["text"] = "dotnet violet payload projection" });
            await ForkClearLifecycleTests.AppendAsync(owner, message);
            canonical = owner.Archive.ReadMessages().Single().MessageJson;
            await seed.ForceVectorIndexAsync(owner);
        }
        var settings = await HttpServerSettings.CaptureDesktopAsync(f.Data);
        await using var host = await MainHost.CreateAsync(
            [],
            f.Data,
            f.Work,
            new ModelConfiguration(f.Data),
            settings,
            null
        );
        await host.App.StartAsync();
        using var admin = new HttpClient { BaseAddress = new(settings.Address.BaseUrl) };
        admin.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);
        var result = (
            await admin.GetFromJsonAsync<JsonObject>(
                "api/history/search?query=dotnet%20violet&limit=1&sessionId=payload-search"
            )
        )!;
        var source = Assert.Single(result["results"]!.AsArray());
        var projected = Assert.Single(source!["messages"]!.AsArray())!.AsObject();
        WebUiMessageTransportTests.AssertProjected(projected);
        Assert.Equal(
            canonical,
            new SqliteArchiveMessageStore(
                Path.Combine(f.Data, "state", "archive-store.sqlite"),
                "payload-search"
            )
                .ReadMessages()
                .Single()
                .MessageJson
        );
    }
}
