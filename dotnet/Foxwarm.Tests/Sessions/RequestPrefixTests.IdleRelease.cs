using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class RequestPrefixTests
{
    [Fact]
    public async Task Owner_idle_release_and_rehydration_keep_the_request_prefix()
    {
        using var temp = new TempDirectory();
        var captures = new List<JsonObject>();
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (_, stream, captured) =>
            {
                lock (captures)
                    captures.Add(JsonNode.Parse(captured.Body)!.AsObject());
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Reply(null))
                );
            }
        );
        await using var manager = await CreateManager(temp.Path, peer.BaseUri);
        var owner = await manager.CreateNamedAsync("main", "released", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Append(owner, Text("older " + new string('a', 2000)));
        await Append(owner, Text("older reply", "model"));
        await Turn(owner);

        manager.IdleReleaseDelay = TimeSpan.Zero;
        Assert.Null(manager.IdleReleaseBlocker(owner));
        Assert.Equal(1, manager.ReleaseIdleOwners());
        var rehydrated = await manager.RequiredAsync(owner.Id);
        Assert.NotSame(owner, rehydrated);
        rehydrated.Registry.TriggerOverride = _ => Task.CompletedTask;
        await Turn(rehydrated);

        Assert.Equal(2, captures.Count);
        var (first, second) = (captures[0], captures[1]);
        Assert.Equal(Instructions(first), Instructions(second));
        Assert.Equal(first["tools"]!.ToJsonString(), second["tools"]!.ToJsonString());
        Assert.Equal(
            first["prompt_cache_key"]?.ToJsonString(),
            second["prompt_cache_key"]?.ToJsonString()
        );
        var earlier = first["input"]!.AsArray();
        var later = second["input"]!.AsArray();
        Assert.True(later.Count > earlier.Count);
        for (var index = 0; index < earlier.Count; index++)
            Assert.Equal(earlier[index]!.ToJsonString(), later[index]!.ToJsonString());
    }
}
