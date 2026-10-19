using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCommandEffectsTests
{
    [Fact]
    public async Task Command_effects_reopen_through_normal_Manager_with_retained_Archive_settings_cache_and_display_filter()
    {
        await using var peer = new ConcurrentPeer(
            1,
            (_, stream, _) => SendAsync(stream, "persisted side result")
        );
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var options = new ResponsesClientOptions(peer.Uri, "wire", "local/wire", "", "", 1024);
        var models = HostModels.ForTest(options);
        string? id = null;
        string? cache = null;
        for (var phase = 0; phase < 2; phase++)
        {
            await using var manager = new SessionManager(data, work, options, models);
            await manager.LoadMainHostAsync();
            var owner =
                phase == 0
                    ? await manager.CreateNamedAsync("main", "reload-effects", null, null)
                    : await manager.RequiredAsync(id!);
            var router = new MessageRouter(new SessionRuntime(manager));
            if (phase == 0)
            {
                id = owner.Id;
                await AppendAsync(
                    owner,
                    Text("original first"),
                    Text("retained second"),
                    Text("retained third")
                );
                await router.HandleMessageAsync(new(id, "webui"), new("/verbose on", null));
                await router.HandleMessageAsync(new(id, "webui"), new("/delete-messages 1", null));
                await manager.RunBtwAsync(owner, "persist across clean reload");
                cache = owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.ToString();
            }
            var state = owner.Entry.Snapshot();
            Assert.Equal(3, state.History.Count);
            Assert.Equal(2, state.History[0].Sequence);
            Assert.Equal(5, state.NextMessageSeq);
            Assert.True(state.AuthorityEnvelope["verbose"]!.GetValue<bool>());
            Assert.Equal(cache, state.AuthorityEnvelope["promptCacheKey"]!.ToString());
            Assert.False(state.History.Last().IsModelVisible);
            Assert.Equal("btw", state.History.Last().ToJson()["__meta"]!["noticeType"]!.ToString());
            Assert.Equal(4, owner.Archive.ReadMessages().Count);
            Assert.Contains(
                "original first",
                owner.Archive.ReadMessages().First().Message.ToJsonString()
            );
        }
        Assert.Single(peer.Requests);
    }

    [Theory]
    [InlineData("999999999999999999999999extra")]
    [InlineData("-999999999999999999999999extra")]
    public async Task Delete_command_clamps_Source_integer_prefix_even_beyond_CLR_integer_range(
        string argument
    )
    {
        await using var f = await FixtureAsync();
        await AppendAsync(f.Owner, Text("a"), Text("b"));
        var reply = await CommandAsync(f, "/delete-messages " + argument);
        Assert.Contains("Deleted 2", reply.Single());
        Assert.Empty(f.Owner.History());
        Assert.Equal(3, f.Owner.Entry.Snapshot().NextMessageSeq);
        Assert.Equal(2, f.Owner.Archive.ReadMessages().Count);
    }

    [Fact]
    public void Btw_WebSocket_cache_partition_is_separate_from_foreground_but_preserves_copied_lineage()
    {
        var lineage = Guid.NewGuid().ToString();
        Assert.Equal(
            lineage,
            ProviderPromptCache.Resolve("openai-responses", "s", lineage, ModelRequestScope.Btw)
        );
        var side = ProviderPromptCache.Resolve("openai-ws", "s", lineage, ModelRequestScope.Btw);
        Assert.NotEqual(
            ProviderPromptCache.Resolve("openai-ws", "s", lineage, ModelRequestScope.Canonical),
            side
        );
        Assert.Equal(
            side,
            ProviderPromptCache.Resolve(
                "openai-ws",
                "s",
                Guid.NewGuid().ToString(),
                ModelRequestScope.Btw
            )
        );
    }
}
