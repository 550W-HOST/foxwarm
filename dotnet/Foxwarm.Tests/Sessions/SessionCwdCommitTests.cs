using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionCwdCommitTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static SessionManager Manager(string root, Action<string, AtomicJsonWriteStage> stage) =>
        new(
            Path.Combine(root, "data"),
            Path.Combine(root, "work"),
            Options,
            HostModels.ForTest(Options),
            authorityStageHook: stage
        );

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cwd_fault_before_or_after_real_rename_publishes_only_actual_committed_delta(
        bool renamed
    )
    {
        using var temp = new TempDirectory();
        Action<string, AtomicJsonWriteStage>? writeStage = null;
        await using var manager = Manager(temp.Path, (id, stage) => writeStage?.Invoke(id, stage));
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "cwd", null, null);
        var before = owner.Entry.Snapshot();
        writeStage = (_, stage) =>
        {
            if (stage == (renamed ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync : AtomicJsonWriteStage.BeforeRename))
            {
                writeStage = null;
                throw new IOException("Owned CWD commit failure.");
            }
        };
        var desired = Path.Combine(temp.Path, "does-not-exist");
        await Assert.ThrowsAnyAsync<Exception>(() => owner.UpdateCwdAsync(desired));
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(temp.Path, "data", "state", "sessions", "cwd.json")
            )
        )!;
        Assert.Equal(renamed ? desired : null, persisted["cwd"]?.GetValue<string>());
        Assert.Equal(
            renamed ? desired : null,
            owner.Entry.Snapshot().AuthorityEnvelope["cwd"]?.GetValue<string>()
        );
        Assert.Equal(
            renamed ? desired : null,
            manager.CatalogPresentations(["cwd"], true)[0]["cwd"]?.GetValue<string>()
        );
        Assert.False(Directory.Exists(desired));
        Assert.True(
            JsonNode.DeepEquals(
                before.AuthorityEnvelope["promptCacheKey"],
                owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]
            )
        );
        Assert.True(
            JsonNode.DeepEquals(
                before.AuthorityEnvelope["persistentMemorySnapshot"],
                owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]
            )
        );
    }

    [Fact]
    public async Task Accepted_cwd_commit_moves_with_same_owner_and_later_settings_and_cwd_keep_each_other()
    {
        using var temp = new TempDirectory();
        Action<string, AtomicJsonWriteStage>? writeStage = null;
        await using var manager = Manager(temp.Path, (id, stage) => writeStage?.Invoke(id, stage));
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "old", null, null);
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        writeStage = (_, stage) =>
        {
            if (stage != AtomicJsonWriteStage.BeforeRename)
                return;
            writeStage = null;
            reached.TrySetResult();
            release.Task.GetAwaiter().GetResult();
        };
        var first = Task.Run(() => owner.UpdateCwdAsync(Path.Combine(temp.Path, "first")));
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var move = manager.MoveIdentityAsync(
                owner,
                new JsonObject { ["newSessionId"] = "new" }
            );
            Assert.False(move.IsCompleted);
            release.TrySetResult();
            await first;
            await move;
            Assert.Same(owner, await manager.RequiredAsync("old"));
            await owner.UpdateSettingsAsync(new JsonObject { ["effort"] = "low" }, false);
            await owner.UpdateCwdAsync(Path.Combine(temp.Path, "later"));
            var current = owner.Entry.Snapshot().AuthorityEnvelope;
            var persisted = JsonNode.Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(temp.Path, "data", "state", "sessions", "new.json")
                )
            )!;
            Assert.Equal("low", current["effort"]!.GetValue<string>());
            Assert.Equal(current["cwd"]!.GetValue<string>(), persisted["cwd"]!.GetValue<string>());
            Assert.Equal("low", persisted["effort"]!.GetValue<string>());
            Assert.False(
                File.Exists(Path.Combine(temp.Path, "data", "state", "sessions", "old.json"))
            );
        }
        finally
        {
            release.TrySetResult();
        }
    }
}
