using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class SessionCommandEffectsTests
{
    [Fact]
    public async Task Btw_provider_retry_keeps_detached_selection_history_and_one_journal_request()
    {
        var reached = Signal(); var release = Signal();
        await using var peer = new ConcurrentPeer(2, async (index, stream, _) =>
        {
            if (index == 0)
            {
                reached.TrySetResult(); await release.Task;
                await LoopbackResponsesServer.WriteResponseAsync(stream, 503, "application/json", "{\"error\":\"temporary\"}"u8.ToArray());
            }
            else await SendAsync(stream, "retry completed");
        });
        await using var f = await FixtureAsync(provider: peer.Uri);
        await AppendAsync(f.Owner, Text("captured context"));
        var request = f.Manager.RunBtwAsync(f.Owner, "side retry");
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await f.Owner.Entry.SaveLane.DeleteMessagesAsync(1);
            await AppendAsync(f.Owner, Text("later context must not leak into side retry"));
            await f.Owner.Entry.SaveLane.CommitSettingsAsync(new JsonObject { ["effort"] = "high" }, f.Manager.Models);
            release.TrySetResult(); await request.WaitAsync(TimeSpan.FromSeconds(10));
            var bodies = peer.Requests.ToArray();
            Assert.Equal(2, bodies.Length);
            Assert.True(JsonNode.DeepEquals(bodies[0]["input"], bodies[1]["input"]));
            Assert.True(JsonNode.DeepEquals(bodies[0]["tools"], bodies[1]["tools"]));
            Assert.Equal(bodies[0]["instructions"]!.ToString(), bodies[1]["instructions"]!.ToString());
            Assert.DoesNotContain("later context", bodies[1]["input"]!.ToJsonString());
            Assert.DoesNotContain(f.Owner.History(), row => row["__meta"]?["noticeType"]?.ToString() == "llm-retry");
            var manifests = await f.Manager.Journal.ListAsync(f.Owner.Id, "btw", null, null, 10);
            var manifest = Assert.Single(manifests);
            var restored = await f.Manager.Journal.ReconstructAsync(manifest!["requestId"]!.ToString());
            Assert.Equal(2, restored["attempts"]!.AsArray().Count);
        }
        finally { release.TrySetResult(); }
    }

    [Theory]
    [InlineData("move")]
    [InlineData("delete")]
    [InlineData("shutdown")]
    public async Task Btw_uses_existing_identity_and_shutdown_owners_without_recreation_or_Stop_takeover(string operation)
    {
        var reached = Signal(); var release = Signal();
        await using var peer = new ConcurrentPeer(1, async (_, stream, _) =>
        {
            reached.TrySetResult(); await release.Task;
            try { await SendAsync(stream, "late side result"); }
            catch (IOException) when (operation == "shutdown") { }
        });
        await using var f = await FixtureAsync(provider: peer.Uri);
        var original = f.Owner.Id;
        var request = f.Manager.RunBtwAsync(f.Owner, "held side work");
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Assert.False(f.Owner.Metadata().Busy);
            Assert.False(f.Owner.Processing);
            if (operation == "move")
            {
                var replies = await CommandAsync(f, "/session move moved");
                Assert.NotEqual(original, f.Owner.Id);
                Assert.DoesNotContain(replies, reply => reply.StartsWith("❌"));
                release.TrySetResult(); await request.WaitAsync(TimeSpan.FromSeconds(10));
                Assert.Single(f.Owner.History(), row => row["__meta"]?["noticeType"]?.ToString() == "btw");
                Assert.Equal(f.Owner.Id, f.Manager.Catalog.Resolve(original)["sessionId"]!.ToString());
            }
            else if (operation == "delete")
            {
                var deleted = await f.Manager.DeleteAsync(original);
                Assert.Equal("deleted", deleted["status"]!.ToString());
                release.TrySetResult();
                await Assert.ThrowsAnyAsync<InvalidDataException>(() => request.WaitAsync(TimeSpan.FromSeconds(10)));
                Assert.Null(f.Manager.Catalog.Get(original));
                Assert.Null(await f.Manager.GetExistingAsync(original));
            }
            else
            {
                await f.Manager.ShutdownAsync().WaitAsync(TimeSpan.FromSeconds(10));
                await Assert.ThrowsAnyAsync<InvalidOperationException>(() => request.WaitAsync(TimeSpan.FromSeconds(10)));
                Assert.DoesNotContain(f.Owner.History(), row => row["__meta"]?["noticeType"]?.ToString() == "btw");
                release.TrySetResult();
            }
        }
        finally { release.TrySetResult(); }
    }

    [Fact]
    public async Task Btw_local_result_append_failure_does_not_retry_successful_provider_generation()
    {
        var reached = Signal(); var release = Signal();
        await using var peer = new ConcurrentPeer(1, async (_, stream, _) =>
        { reached.TrySetResult(); await release.Task; await SendAsync(stream, "successful provider output"); });
        await using var f = await FixtureAsync(provider: peer.Uri);
        await AppendAsync(f.Owner, Text("canonical context"));
        var request = f.Manager.RunBtwAsync(f.Owner, "local failure");
        var directory = Path.Combine(f.Data, "state", "sessions");
        var held = directory + "-owned-test-hold";
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            Directory.Move(directory, held);
            await File.WriteAllTextAsync(directory, "owned write obstruction");
            release.TrySetResult();
            await Assert.ThrowsAnyAsync<IOException>(() => request.WaitAsync(TimeSpan.FromSeconds(10)));
            Assert.Single(peer.Requests);
            Assert.Single(f.Owner.History());
            Assert.Single(f.Owner.Archive.ReadMessages());
        }
        finally
        {
            release.TrySetResult();
            if (File.Exists(directory)) File.Delete(directory);
            if (Directory.Exists(held)) Directory.Move(held, directory);
        }
    }
}
