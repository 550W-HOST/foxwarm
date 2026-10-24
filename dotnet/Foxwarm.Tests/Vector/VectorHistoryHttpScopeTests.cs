using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorHistoryHttpScopeTests
{
    [Theory]
    [InlineData("", false, false)]
    [InlineData("&sessionId=", false, false)]
    [InlineData("&agentName=scope-a", true, false)]
    [InlineData("&agentName=scope-a&sessionId=", true, false)]
    [InlineData("&sessionId=scope-a%2Frenamed", true, true)]
    [InlineData("&sessionId=scope-a%2Fparent_child", true, true)]
    public async Task Authenticated_history_route_reloads_each_source_unless_a_nonempty_exact_session_is_selected(
        string scope,
        bool excludeOtherAgent,
        bool exact
    )
    {
        await using var f = await VectorFixture.CreateAsync();
        const string parentId = "scope-a/parent";
        const string childId = "scope-a/renamed";
        const string otherId = "scope-b/other";
        await using (var seed = await f.ManagerAsync(lexical: true))
        {
            await seed.CreateAgentAsync("scope-a", false);
            await seed.CreateAgentAsync("scope-b", false);
            var parent = await seed.CreateNamedAsync("scope-a", "parent", null, null);
            await ForkClearLifecycleTests.AppendAsync(
                parent,
                Enumerable.Range(1, 10)
                    .Select(index => VectorFixture.Message("dotnet violet parent context " + index))
                    .ToArray()
            );
            var child = await seed.ForkAsync(parent, "child");
            Assert.Equal("scope-a/parent_child", child.Id);
            await seed.MoveIdentityAsync(
                parent,
                new JsonObject { ["sessionId"] = child.Id, ["newSessionId"] = "renamed" }
            );
            await ForkClearLifecycleTests.AppendAsync(
                child,
                VectorFixture.Message("dotnet violet child context")
            );
            await ForkClearLifecycleTests.AppendAsync(
                parent,
                Enumerable.Range(11, 30)
                    .Select(index => VectorFixture.Message("dotnet violet late parent " + index))
                    .ToArray()
            );
            var other = await seed.CreateNamedAsync("scope-b", "other", null, null);
            await ForkClearLifecycleTests.AppendAsync(
                other,
                VectorFixture.Message("dotnet violet other agent context")
            );
            foreach (var owner in new[] { parent, child, other })
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
        var path = "api/history/search?query=dotnet%20violet&limit=5" + scope;
        using var response = await admin.GetAsync(path);
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{path}: {response.StatusCode} {body}");
        var result = JsonNode.Parse(body)!.AsObject();
        var sources = result["results"]!.AsArray().OfType<JsonObject>().ToArray();
        Assert.Equal(excludeOtherAgent ? 2 : 3, sources.Length);
        Assert.Equal("hybrid search", result["searchKind"]!.GetValue<string>());
        Assert.NotEmpty(f.Peer.Requests);
        Assert.Equal(
            exact ? new[] { childId } : excludeOtherAgent ? new[] { parentId, childId }.Order().ToArray()
                : new[] { parentId, childId, otherId }.Order().ToArray(),
            sources.Select(source => source["sessionId"]!.GetValue<string>()).Distinct().Order().ToArray()
        );
        Assert.Single(sources, source =>
            source["sessionId"]!.GetValue<string>() == (exact ? childId : parentId)
            && source["sourceRange"]!["startSeq"]!.GetValue<int>() == 1
        );
        foreach (var source in sources)
        {
            Assert.Equal("messages", source["kind"]!.GetValue<string>());
            var messages = source["messages"]!.AsArray();
            Assert.InRange(messages.Count, 1, 16);
            Assert.Equal(messages[0]!["__meta"]!["seq"]!.GetValue<int>(), source["firstSeq"]!.GetValue<int>());
            Assert.Equal(messages[^1]!["__meta"]!["seq"]!.GetValue<int>(), source["lastSeq"]!.GetValue<int>());
            if (source["sourceRange"]!["startSeq"]!.GetValue<int>() == 1
                && source["sessionId"]!.GetValue<string>() == (exact ? childId : parentId))
            {
                Assert.Equal(exact ? childId : parentId, source["sessionId"]!.GetValue<string>());
                Assert.Equal(exact ? 10 : 40, source["sourceRange"]!["endSeq"]!.GetValue<int>());
                Assert.Contains("parent context", messages.ToJsonString());
                Assert.DoesNotContain("child context", messages.ToJsonString());
                Assert.Equal(source["firstSeq"]!.GetValue<int>() > 1, source["hasEarlier"]!.GetValue<bool>());
                Assert.True(source["hasLater"]!.GetValue<bool>());
            }
            else if (source["sessionId"]!.GetValue<string>() == childId)
            {
                Assert.Contains("child context", messages.ToJsonString());
                Assert.DoesNotContain("late parent", messages.ToJsonString());
                Assert.True(source["hasEarlier"]!.GetValue<bool>());
                Assert.False(source["hasLater"]!.GetValue<bool>());
            }
        }
        if (!excludeOtherAgent)
        {
            var other = Assert.Single(sources, source => source["sessionId"]!.GetValue<string>() == otherId);
            Assert.Contains("other agent context", other["messages"]!.ToJsonString());
            Assert.False(other["hasEarlier"]!.GetValue<bool>());
            Assert.False(other["hasLater"]!.GetValue<bool>());
        }
        if (exact)
        {
            Assert.DoesNotContain("late parent", body);
            Assert.DoesNotContain("other agent context", body);
        }
    }
}
