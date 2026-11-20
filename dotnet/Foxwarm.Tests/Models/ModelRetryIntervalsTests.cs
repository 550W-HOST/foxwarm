using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ModelRetryIntervalsTests
{
    private static JsonObject Document() =>
        JsonNode
            .Parse(
                """
                {"default":"route","defaults":{"retryIntervalsMs":[11,22]},"providers":{
                  "a":{"baseUrl":"http://localhost","retryIntervalsMs":[33],"models":["inherited",{"id":"override","retryIntervalsMs":[44,55]}]},
                  "b":{"baseUrl":"http://localhost"},
                  "alias":"a/override",
                  "pool":{"providerType":"session-hash","targets":["a/override"],"retryIntervalsMs":[66]},
                  "route":{"providerType":"failover","targets":["a/override","b"],"failureThreshold":2}
                }}
                """
            )!
            .AsObject();

    [Fact]
    public void Concrete_overrides_and_virtual_routes_resolve_without_inheriting_target_intervals()
    {
        var document = Document();
        var models = HostModels.Parse(document, new JsonObject());
        Assert.Equal(new[] { 44, 55 }, models.GetRetryIntervals("a/override"));
        Assert.Equal(new[] { 33 }, models.GetRetryIntervals("a/inherited"));
        Assert.Equal(new[] { 11, 22 }, models.GetRetryIntervals("b"));
        Assert.Equal(new[] { 11, 22 }, models.GetRetryIntervals("alias"));
        Assert.Equal(new[] { 66 }, models.GetRetryIntervals("pool"));
        Assert.Equal(new[] { 11, 22 }, models.GetRetryIntervals("route"));
        document["providers"]!["route"]!["retryIntervalsMs"] = new JsonArray(77, 88);
        var changed = HostModels.Parse(document, new JsonObject());
        Assert.Equal(new[] { 77, 88 }, changed.GetRetryIntervals("route"));
        Assert.Equal(
            models.Resolve("route").Configuration["fingerprint"]!.ToString(),
            changed.Resolve("route").Configuration["fingerprint"]!.ToString()
        );
        document.Remove("defaults");
        var builtins = HostModels.Parse(document, new JsonObject());
        Assert.Equal(
            new[] { 2000, 5000, 10000, 20000, 40000, 60000 },
            builtins.GetRetryIntervals("alias")
        );
        Assert.Equal(
            new[] { 2000, 5000, 10000, 20000, 40000, 60000 },
            builtins.GetRetryIntervals("removed")
        );
    }

    [Theory]
    [InlineData("null")]
    [InlineData("1000")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("[null]")]
    [InlineData("[-1]")]
    [InlineData("[0.5]")]
    [InlineData("[2147483648]")]
    [InlineData("[\"1000\"]")]
    [InlineData("[true]")]
    public void Invalid_intervals_are_rejected_at_every_scope_even_when_overridden(string raw)
    {
        foreach (var scope in new[] { "defaults", "provider", "model", "virtual" })
        {
            var document = Document();
            var target = scope switch
            {
                "defaults" => document["defaults"]!,
                "provider" => document["providers"]!["a"]!,
                "model" => document["providers"]!["a"]!["models"]![1]!,
                _ => document["providers"]!["route"]!,
            };
            target["retryIntervalsMs"] = JsonNode.Parse(raw);
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(document, new JsonObject()));
        }
    }

    [Fact]
    public async Task Saves_apply_intervals_live_and_invalid_saves_preserve_the_installed_catalog()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var document = Document();
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        var captured = configuration.Capture();
        document["providers"]!["route"]!["retryIntervalsMs"] = new JsonArray(0, int.MaxValue);
        var saved = document.ToJsonString();
        var receipt = await configuration.SaveAsync(new JsonObject { ["yaml"] = saved });
        Assert.Empty(receipt["restartRequired"]!.AsArray());
        Assert.Equal(new[] { 0, int.MaxValue }, configuration.Models.GetRetryIntervals("route"));
        Assert.Equal(new[] { 11, 22 }, captured.GetRetryIntervals("route"));
        document["providers"]!["route"]!["retryIntervalsMs"] = new JsonArray();
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() })
        );
        Assert.Equal(saved, await File.ReadAllTextAsync(configuration.ActivePath));
        Assert.Equal(new[] { 0, int.MaxValue }, configuration.Models.GetRetryIntervals("route"));
        document["providers"]!["route"]!.AsObject().Remove("retryIntervalsMs");
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        Assert.Equal(new[] { 11, 22 }, configuration.Models.GetRetryIntervals("route"));
    }

    [Fact]
    public async Task Normal_session_uses_live_route_intervals_without_retiming_a_wait_or_recapturing_leaf_options()
    {
        const string done =
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n";
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, _) =>
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    index == 2 ? 200 : 503,
                    index == 2 ? "text/event-stream" : "application/json",
                    Encoding.UTF8.GetBytes(index == 2 ? done : "unavailable")
                )
        );
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, environment: _ => null);
        var configuration = new ModelConfiguration(paths);
        var document = Document();
        document["providers"]!["a"]!["baseUrl"] = peer.BaseUri.ToString();
        document["providers"]!["b"]!["baseUrl"] = peer.BaseUri.ToString();
        document["defaults"]!["maxOutput"] = 713;
        document["providers"]!["route"]!["retryIntervalsMs"] = new JsonArray(0);
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "workspace"),
            new(peer.BaseUri, "unused", "unused", "", "", 713),
            configuration.Models
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "retry", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var notices = new List<ModelRetryEvent>();
        owner.Entry.RetryPresented = async (notice, _, _) =>
        {
            notices.Add(notice);
            if (notice.Attempt == 1)
            {
                document["providers"]!["route"]!["retryIntervalsMs"] = new JsonArray(7200000, 25);
                document["defaults"]!["maxOutput"] = 999;
                await configuration.SaveAsync(
                    new JsonObject { ["yaml"] = document.ToJsonString() }
                );
            }
        };
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("hello"));
        await owner.Registry.Runner.ProcessQueueAsync(owner.Id).WaitAsync(TimeSpan.FromSeconds(20));
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(new int?[] { 0, 25 }, notices.Select(notice => notice.DelayMs));
        Assert.Equal(
            new[] { "a/override", "a/override" },
            notices.Select(notice => notice.ModelId)
        );
        Assert.Equal(3, peer.RequestCount);
        for (var index = 0; index < 3; index++)
        {
            var body = JsonNode.Parse((await peer.RequestAt(index)).Body)!;
            Assert.Equal(713, body["max_output_tokens"]!.GetValue<int>());
        }
        Assert.Equal(999, configuration.Capture().Resolve("b").MaxOutput);
    }
}
