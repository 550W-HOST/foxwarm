using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionMovedDeletionTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_move_chain_keeps_pending_fences_but_completed_delete_removes_every_resident_alias(
        bool unlinkFailure
    )
    {
        await using var f = await WebUiDownloadTests.Fixture.Create();
        var manager = f.Manager;
        var caller = await manager.CreateNamedAsync("main", "caller", null, null);
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "Retained moved original." }),
            }
        );
        await manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "middle" });
        await manager.MoveIdentityAsync(owner, new JsonObject { ["newSessionId"] = "current" });
        var ids = new[] { "old", "middle", "current" };
        var endpoints = new[] { "history", "history/continuous", "state" };
        async Task<JsonObject> Tool(string id) =>
            (
                await manager.ExecuteAgentToolAsync(
                    caller,
                    "get_session_messages",
                    new JsonObject { ["sessionId"] = id }
                )
            ).Response.AsObject();
        foreach (var id in ids)
        {
            Assert.Same(owner, await manager.GetExistingAsync(id));
            Assert.Contains(
                "Retained moved original.",
                (await Tool(id))["output"]!.GetValue<string>()
            );
            foreach (var endpoint in endpoints)
            {
                using var response = await f.Admin.GetAsync($"api/sessions/{id}/{endpoint}");
                Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            }
        }
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var authority = owner.AuthorityStore.AuthorityPath;
        var saved = authority + ".held";
        manager.BeforeDeleteStage = async (stage, _) =>
        {
            if (stage == "tracking")
            {
                reached.TrySetResult();
                await release.Task;
            }
            if (stage == "json-unlink" && unlinkFailure)
            {
                File.Move(authority, saved);
                Directory.CreateDirectory(authority);
            }
        };
        async Task Unavailable()
        {
            foreach (var id in ids)
            {
                Assert.Equal(
                    "SESSION_STATE_UNAVAILABLE",
                    (await Tool(id))["error"]!["type"]!.GetValue<string>()
                );
                foreach (var endpoint in endpoints)
                {
                    using var response = await f.Admin.GetAsync($"api/sessions/{id}/{endpoint}");
                    Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
                }
            }
            await caller.Entry.SaveLane.SaveStrictAsync();
        }
        var deleting = manager.DeleteAsync(owner.Id, source: caller);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await Unavailable();
        }
        finally
        {
            release.TrySetResult();
        }
        JsonObject result;
        if (unlinkFailure)
        {
            var failure = await Assert.ThrowsAsync<SessionDeletionException>(() => deleting);
            Assert.Equal("SESSION_TREE_DELETE_PARTIAL", failure.Code);
            Assert.Equal("json-unlink", failure.Details["failedStage"]!.GetValue<string>());
            Assert.Equal(
                "current",
                Assert.Single(failure.Details["remainingSessionIds"]!.AsArray())!.GetValue<string>()
            );
            Assert.NotNull(manager.Catalog.Get("current"));
            await Unavailable();
            Directory.Delete(authority);
            File.Move(saved, authority);
            manager.BeforeDeleteStage = null;
            result = await manager.DeleteAsync(owner.Id, source: caller);
            Assert.True(result["continuedSameHost"]!.GetValue<bool>());
        }
        else
            result = await deleting;
        Assert.Equal("deleted", result["status"]!.GetValue<string>());
        Assert.True(result["success"]!.GetValue<bool>());
        Assert.Empty(result["remainingSessionIds"]!.AsArray());
        Assert.Empty(result["stillClaimedSessionIds"]!.AsArray());
        foreach (var id in ids)
        {
            Assert.Null(await manager.GetExistingAsync(id));
            var tool = await Tool(id);
            Assert.Null(tool["error"]);
            Assert.Contains("not found", tool["output"]!.GetValue<string>());
            foreach (var endpoint in endpoints)
            {
                using var response = await f.Admin.GetAsync($"api/sessions/{id}/{endpoint}");
                Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            }
            var archive = manager.ArchiveReader(id);
            Assert.Equal("current", archive.CanonicalSessionId);
            Assert.Contains(
                "Retained moved original.",
                Assert.Single(archive.ReadMessages()).MessageJson
            );
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                manager.CreateNamedAsync("main", id, null, null)
            );
        }
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() =>
            owner.Entry.SaveLane.SaveStrictAsync()
        );
        Assert.Same(caller, await manager.GetExistingAsync(caller.Id));
    }
}
