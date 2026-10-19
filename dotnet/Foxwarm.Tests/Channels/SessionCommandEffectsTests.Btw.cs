using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCommandEffectsTests
{
    [Theory]
    [InlineData("text")]
    [InlineData("empty")]
    [InlineData("tool")]
    [InlineData("error")]
    [InlineData("virtual")]
    public async Task Btw_real_command_matches_Source_result_and_persists_only_display_notice(
        string kind
    )
    {
        var args = new JsonObject
        {
            ["filePath"] = "btw-must-not-exist.txt",
            ["content"] = "side effect",
        };
        await using var peer = new ConcurrentPeer(
            1,
            async (_, stream, _) =>
            {
                if (kind == "error")
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        400,
                        "application/json",
                        "{\"error\":\"rejected\"}"u8.ToArray()
                    );
                else
                    await SendAsync(
                        stream,
                        kind == "empty" ? null : "  side answer  ",
                        kind == "tool" ? ProviderCall("write", args) : null
                    );
            }
        );
        await using var f = await FixtureAsync(provider: peer.Uri);
        if (kind == "virtual")
        {
            var configured = JsonNode
                .Parse(await File.ReadAllTextAsync(f.Configuration.ActivePath))!
                .AsObject();
            configured["providers"]!["virtual"] = new JsonObject
            {
                ["providerType"] = "session-hash",
                ["targets"] = new JsonArray("local/wire"),
            };
            configured["default"] = "virtual";
            await File.WriteAllTextAsync(f.Configuration.ActivePath, configured.ToJsonString());
        }
        await AppendAsync(f.Owner, Text("background context"));
        var resultReady = Signal();
        f.Owner.Changed += value =>
        {
            if (
                value.Kind == SessionEventKind.MessageCommitted
                && value.Data?["__meta"]?["noticeType"]?.ToString() == "btw"
            )
                resultReady.TrySetResult();
        };
        var replies = await CommandAsync(f, "/btw side question");
        Assert.Single(replies);
        Assert.Contains("started", replies[0]);
        await resultReady.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var notice = Assert.Single(
            f.Owner.History(),
            row => row["__meta"]?["noticeType"]?.ToString() == "btw"
        );
        Assert.False(notice["modelVisible"]!.GetValue<bool>());
        Assert.Equal(2, f.Owner.History().Count);
        Assert.False(f.Owner.Metadata().Busy);
        Assert.False(
            File.Exists(Path.Combine(f.Manager.AgentDirectory("main"), "btw-must-not-exist.txt"))
        );
        var sourceResult =
            kind == "tool"
                ? new JsonObject
                {
                    ["toolCalls"] = new JsonArray(
                        new JsonObject { ["name"] = "write", ["args"] = args.DeepClone() }
                    ),
                    ["modelId"] = "local/wire",
                }
                : new JsonObject
                {
                    ["text"] = kind == "empty" ? "" : "  side answer  ",
                    ["modelId"] = "local/wire",
                };
        if (kind == "virtual")
            sourceResult["virtualModelKey"] = "virtual";
        var source = await SourceAsync(
            new JsonObject
            {
                ["operation"] = "btw",
                ["result"] = sourceResult,
                ["error"] =
                    kind == "error"
                        ? notice["parts"]![0]!["text"]!.ToString().Split("⚠️ [BTW error]\n")[1]
                        : null,
            }
        );
        Assert.Equal(
            source["display"]!["text"]!.ToString(),
            notice["parts"]![0]!["text"]!.ToString()
        );
        if (kind != "error")
            Assert.Equal("local/wire", notice["__meta"]!["modelId"]!.ToString());
        if (kind == "virtual")
            Assert.Equal("virtual", notice["__meta"]!["virtualModelKey"]!.ToString());
        var saved = await f.Owner.AuthorityStore.LoadAsync(f.Owner.Id);
        Assert.True(JsonNode.DeepEquals(notice, saved!.History.Last().ToJson()));
        if (kind == "tool")
        {
            var usable = await f.ToolAsync("write", args);
            Assert.Null(usable?["error"]);
            Assert.Equal(
                "side effect",
                await File.ReadAllTextAsync(
                    Path.Combine(f.Manager.AgentDirectory("main"), "btw-must-not-exist.txt")
                )
            );
        }
        var request = Assert.Single(peer.Requests);
        Assert.Contains(request["tools"]!.AsArray(), row => row?["name"]?.ToString() == "write");
        var sourceParts = source["effects"]![0]!["parts"]!.ToJsonString();
        var requestText = request["input"]!.ToJsonString();
        Assert.Contains("side-request", requestText);
        Assert.Contains("side question", requestText);
        Assert.Contains("Do not call tools", sourceParts);
        var manifests = await f.Manager.Journal.ListAsync(f.Owner.Id, "btw", null, null, 10);
        Assert.Single(manifests);
        var reconstructed = await f.Manager.Journal.ReconstructAsync(
            manifests[0]!["requestId"]!.ToString()
        );
        Assert.Contains("side question", reconstructed.ToJsonString());
        Assert.DoesNotContain("BTW result", reconstructed.ToJsonString());
    }

    [Fact]
    public async Task Btw_keeps_copied_context_schema_cache_and_independent_Stop_while_main_is_active()
    {
        var mainReached = Signal();
        var sideReached = Signal();
        var releaseMain = Signal();
        var releaseSide = Signal();
        await using var peer = new ConcurrentPeer(
            3,
            async (index, stream, _) =>
            {
                if (index == 0)
                {
                    mainReached.TrySetResult();
                    await releaseMain.Task;
                }
                if (index == 1)
                {
                    sideReached.TrySetResult();
                    await releaseSide.Task;
                }
                try
                {
                    await SendAsync(stream, index == 1 ? "detached result" : "normal result");
                }
                catch (IOException) when (index == 0) { }
            }
        );
        await using var f = await FixtureAsync(provider: peer.Uri);
        var ready = Signal();
        f.Owner.Changed += value =>
        {
            if (
                value.Kind == SessionEventKind.MessageCommitted
                && value.Data?["__meta"]?["noticeType"]?.ToString() == "btw"
            )
                ready.TrySetResult();
        };
        try
        {
            await f.Owner.Registry.Ingress.EnqueueAsync(
                f.Owner.Id,
                QueueItem.UserText("foreground input")
            );
            var running = f.Owner.StartProcessing();
            await mainReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var before = f.Owner.Entry.Snapshot();
            var replies = await CommandAsync(f, "/btw copied side request");
            await sideReached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Single(replies);
            Assert.True(f.Owner.Metadata().Busy);
            Assert.Equal(
                before.AuthorityEnvelope["persistentMemorySnapshot"]!.ToString(),
                f.Owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.ToString()
            );
            Assert.True(
                JsonNode.DeepEquals(
                    before.Meta["lastEffectiveRequest"],
                    f.Owner.Entry.Snapshot().Meta["lastEffectiveRequest"]
                )
            );
            Assert.DoesNotContain(
                "copied side request",
                string.Join('\n', f.Owner.History().Select(row => row.ToJsonString()))
            );
            await CommandAsync(f, "/stop");
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.False(ready.Task.IsCompleted);
            releaseMain.TrySetResult();
            releaseSide.TrySetResult();
            await ready.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.False(f.Owner.Metadata().Busy);
            await f.Owner.Registry.Ingress.EnqueueAsync(
                f.Owner.Id,
                QueueItem.UserText("after side result")
            );
            await f.Owner.StartProcessing().WaitAsync(TimeSpan.FromSeconds(10));
            var requests = peer.Requests.ToArray();
            Assert.Equal(3, requests.Length);
            var normalManifests = await f.Manager.Journal.ListAsync(
                f.Owner.Id,
                "normal-turn",
                null,
                null,
                10
            );
            var sideManifest = Assert.Single(
                await f.Manager.Journal.ListAsync(f.Owner.Id, "btw", null, null, 10)
            );
            var mainJournal = await f.Manager.Journal.ReconstructAsync(
                normalManifests.Last()!["requestId"]!.ToString()
            );
            var sideJournal = await f.Manager.Journal.ReconstructAsync(
                sideManifest!["requestId"]!.ToString()
            );
            Assert.Equal(
                mainJournal["promptCacheKeyHash"]!.ToString(),
                sideJournal["promptCacheKeyHash"]!.ToString()
            );
            Assert.Equal(
                requests[0]["instructions"]!.ToString(),
                requests[1]["instructions"]!.ToString()
            );
            Assert.True(JsonNode.DeepEquals(requests[0]["tools"], requests[1]["tools"]));
            Assert.DoesNotContain("detached result", requests[2]["input"]!.ToJsonString());
            Assert.DoesNotContain("copied side request", requests[2]["input"]!.ToJsonString());
            Assert.Single(
                f.Owner.History(),
                row => row["__meta"]?["noticeType"]?.ToString() == "btw"
            );
            Assert.Single(await f.Manager.Journal.ListAsync(f.Owner.Id, "btw", null, null, 10));
        }
        finally
        {
            releaseMain.TrySetResult();
            releaseSide.TrySetResult();
        }
    }
}
