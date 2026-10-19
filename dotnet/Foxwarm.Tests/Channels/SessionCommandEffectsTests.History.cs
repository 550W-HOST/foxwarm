using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCommandEffectsTests
{
    [Theory]
    [InlineData(2)]
    [InlineData(-2)]
    [InlineData(99)]
    [InlineData(-99)]
    public async Task Delete_real_command_matches_Source_active_slice_indexing_and_retains_Archive_identity(
        int count
    )
    {
        await using var f = await FixtureAsync();
        await AppendAsync(f.Owner, Text("first"), Text("second"), Text("third"), Text("fourth"));
        f.Owner.Entry.WithState(state =>
        {
            state.AuthorityEnvelope["vectorIndexPosition"] = 3;
            state.AuthorityEnvelope["nextBlockId"] = 12;
        });
        await f.Owner.Entry.SaveLane.SaveStrictAsync();
        var before = f.Owner.Entry.Snapshot();
        var expected = await SourceAsync(
            new JsonObject
            {
                ["operation"] = "delete",
                ["count"] = count,
                ["session"] = new JsonObject
                {
                    ["id"] = f.Owner.Id,
                    ["history"] = new JsonArray(
                        before.History.Materialize().Select(row => (JsonNode)row).ToArray()
                    ),
                    ["vectorIndexPosition"] = 3,
                    ["indexingState"] = new JsonObject(),
                    ["historyVersion"] = before.HistoryVersion,
                },
            }
        );
        var replies = await CommandAsync(f, "/delete-messages " + count);
        Assert.Contains("Deleted " + expected["result"]!["deleted"], replies.Single());
        var after = f.Owner.Entry.Snapshot();
        Assert.Equal(
            expected["session"]!["history"]!.ToJsonString(),
            new JsonArray(
                after.History.Materialize().Select(row => (JsonNode)row).ToArray()
            ).ToJsonString()
        );
        Assert.Equal(
            expected["session"]!["vectorIndexPosition"]!.ToString(),
            after.AuthorityEnvelope["vectorIndexPosition"]!.ToString()
        );
        Assert.Null(after.AuthorityEnvelope["indexingState"]);
        Assert.Equal(before.HistoryVersion + 1, after.HistoryVersion);
        Assert.Equal(before.NextMessageSeq, after.NextMessageSeq);
        Assert.Equal(12, after.AuthorityEnvelope["nextBlockId"]!.GetValue<int>());
        Assert.Equal(4, f.Owner.Archive.ReadMessages().Count);
        Assert.Equal(
            before.History.Select(row => row.ToJsonString()),
            f.Owner.Archive.ReadMessages().Select(row => row.Message.ToJsonString())
        );
        var loaded = await f.Owner.AuthorityStore.LoadAsync(f.Owner.Id);
        Assert.Equal(
            after.History.Select(row => row.ToJsonString()),
            loaded!.History.Select(row => row.ToJsonString())
        );
        await AppendAsync(f.Owner, Text("later"));
        Assert.Equal(before.NextMessageSeq, f.Owner.Entry.Snapshot().History.Last().Sequence);
        Assert.Equal(5, f.Owner.Archive.ReadMessages().Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Delete_save_lane_preserves_actual_pre_and_post_rename_truth_without_Archive_purge(
        bool renamed
    )
    {
        using var temp = new TempDirectory();
        var fail = false;
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "s",
            authorityStageHook: stage =>
            {
                if (
                    fail
                    && stage
                        == (
                            renamed
                                ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                                : AtomicJsonWriteStage.BeforeRename
                        )
                )
                    throw new IOException("Owned deletion write fault");
            }
        );
        var state = new SessionState("s");
        var entry = new SessionEntry(state, store);
        await entry.SaveLane.CommitCanonicalAppendAsync(live =>
            LocalSessionTurnHost.PrepareCanonicalAppend(
                live,
                [Text("a"), Text("b")],
                [],
                false,
                false,
                () => 1
            )
        );
        fail = true;
        await Assert.ThrowsAnyAsync<IOException>(() => entry.SaveLane.DeleteMessagesAsync(-1));
        var loaded = await store.LoadAsync("s");
        Assert.Equal(renamed ? 1 : 2, state.History.Count);
        Assert.Equal(state.History.Count, loaded!.History.Count);
        Assert.Equal(renamed ? 1 : 0, state.HistoryVersion);
        Assert.Equal(3, state.NextMessageSeq);
        Assert.Equal(2, store.Archive.ReadMessages().Count);
        fail = false;
        await entry.SaveLane.DeleteMessagesAsync(1);
        Assert.Equal(renamed ? 0 : 1, state.History.Count);
    }

    [Fact]
    public async Task Delete_during_real_provider_request_keeps_new_output_and_newest_retry_tail_contract()
    {
        var reached = Signal();
        var release = Signal();
        await using var peer = new ConcurrentPeer(
            1,
            async (_, stream, _) =>
            {
                reached.TrySetResult();
                await release.Task;
                await SendAsync(stream, "retained later output");
            }
        );
        await using var f = await FixtureAsync(provider: peer.Uri);
        await AppendAsync(f.Owner, Text("old context"));
        await f.Owner.Registry.Ingress.EnqueueAsync(
            f.Owner.Id,
            QueueItem.UserText("in flight input")
        );
        var running = f.Owner.StartProcessing();
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            var before = f.Owner.Entry.Snapshot();
            var result = await CommandAsync(f, "/delete-messages 1");
            Assert.Contains("Deleted 1", result.Single());
            Assert.True(f.Owner.Metadata().Busy);
            release.TrySetResult();
            await running.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Contains("retained later output", f.Owner.History().Last().ToJsonString());
            Assert.Equal(before.NextMessageSeq, f.Owner.Entry.Snapshot().History.Last().Sequence);
            Assert.Equal(3, f.Owner.Archive.ReadMessages().Count);
            await CommandAsync(f, "/delete-messages -1");
            Assert.Equal("user", f.Owner.History().Last()["role"]!.ToString());
            Assert.True(SessionContinuation.IsIncomplete(f.Owner.Entry.Snapshot().History));
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public async Task Manual_tools_command_prunes_below_automatic_gate_preserves_skill_recent_args_and_original_recall()
    {
        await using var f = await FixtureAsync();
        var args = new JsonObject { ["filePath"] = "sample", ["padding"] = new string('a', 20000) };
        var skillArgs = new JsonObject { ["action"] = "load", ["skillName"] = "fixture" };
        await AppendAsync(
            f.Owner,
            Call("read", "read-id", args),
            Response("read", "read-id", new string('x', 5000)),
            Call("skill", "skill-id", skillArgs),
            Response("skill", "skill-id", new string('s', 3000)),
            Text(new string('r', 15000)),
            Text("recent untouched")
        );
        var before = f.Owner.Entry.Snapshot();
        var source = await SourceAsync(
            new JsonObject
            {
                ["operation"] = "prune",
                ["keep"] = .3,
                ["session"] = new JsonObject
                {
                    ["id"] = f.Owner.Id,
                    ["history"] = new JsonArray(
                        before.History.Materialize().Select(row => (JsonNode)row).ToArray()
                    ),
                    ["historyVersion"] = 0,
                },
            }
        );
        var result = await CommandAsync(f, "/compact tools malformed");
        Assert.Contains("Pruned 1 oversized response(s) across 1 message(s)", result.Single());
        var estimates = System.Text.RegularExpressions.Regex.Match(
            result.Single(),
            @"estimated (\d+) token\(s\) saved \((\d+) → (\d+)\)"
        );
        Assert.True(estimates.Success, result.Single());
        Assert.Equal(
            int.Parse(estimates.Groups[2].Value) - int.Parse(estimates.Groups[3].Value),
            int.Parse(estimates.Groups[1].Value)
        );
        Assert.True(int.Parse(estimates.Groups[1].Value) > 0);
        var after = f.Owner.Entry.Snapshot();
        Assert.True(after.History[0].ContentEquals(before.History[0]));
        Assert.True(after.History[3].ContentEquals(before.History[3]));
        Assert.True(after.History[4].ContentEquals(before.History[4]));
        Assert.True(after.History[5].ContentEquals(before.History[5]));
        Assert.Contains("historical tool response pruned", after.History[1].ToJsonString());
        var expected = source["result"]!;
        Assert.True(
            expected["estimatedTokensAfter"]!.GetValue<int>()
                >= expected["estimatedTokensBefore"]!.GetValue<int>() * .6
        );
        Assert.Equal(
            before.History.Select(row => row.ToJsonString()),
            f.Owner.Archive.ReadMessages().Select(row => row.Message.ToJsonString())
        );
        var recalled = await ArchiveRecallTool.ExecuteAsync(
            f.Manager,
            f.Owner,
            new JsonObject
            {
                ["target"] = "msg#2",
                ["previewLength"] = 20000,
                ["toolDetail"] = "full",
            },
            default
        );
        Assert.Contains(new string('x', 2000), recalled!.ToJsonString());
        Assert.Empty(await f.Manager.Journal.ListAsync(f.Owner.Id, null, null, null, 10));
        Assert.False(f.Owner.Compactor.Active);
        var feedback = new List<JsonNode?>();
        f.Owner.Changed += value =>
        {
            if (value.Kind == SessionEventKind.ModelStream)
                feedback.Add(value.Data);
        };
        await f.Router.HandleMessageAsync(
            new(f.Owner.Id, "webui"),
            new("/compact tools 100", null, ControlRequestId: "manual-tools")
        );
        var single = Assert.Single(feedback);
        Assert.Equal("manual-tools", single!["requestId"]!.ToString());
        Assert.Equal("accepted", single["feedback"]!["status"]!.ToString());
        Assert.Equal(before.History.Count, f.Owner.History().Count);
    }
}
