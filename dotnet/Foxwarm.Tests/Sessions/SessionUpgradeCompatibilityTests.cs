using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionUpgradeCompatibilityTests
{
    private static ResponsesClientOptions Options => new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    internal static async Task Seed(string root, string id, bool required = false)
    {
        using var catalog = new SessionCatalog(root);
        catalog.Initialize();
        await SessionCatalogMigrationTests.Authority(root, id);
        var row = SessionCatalogTests.Row(id, 0);
        if (required)
            row["queueLength"] = 1;
        catalog.Upsert([row]);
    }

    [Theory]
    [InlineData(1L)]
    [InlineData(106L)]
    [InlineData(9007199254740991L)]
    public async Task Historical_worker_cursor_survives_cold_load_and_ordinary_strict_saves(long cursor)
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, "retained");
        var file = Path.Combine(temp.Path, "state", "sessions", "retained.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["lastAppliedMailboxId"] = cursor;
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        await using (var manager = new SessionManager(temp.Path, Path.Combine(temp.Path, "work"), Options, HostModels.ForTest(Options)))
        {
            await manager.LoadAsync();
            Assert.Empty(manager.Owners());
            var owner = await manager.RequiredAsync("retained");
            Assert.Equal(cursor, owner.Entry.Snapshot().AuthorityEnvelope["lastAppliedMailboxId"]!.GetValue<long>());
            await owner.Entry.SaveLane.SaveStrictAsync();
            Assert.Equal(cursor, JsonNode.Parse(await File.ReadAllTextAsync(file))!["lastAppliedMailboxId"]!.GetValue<long>());
        }
        var reopened = await new PersistentSessionAuthorityStore(temp.Path, "retained").LoadAsync("retained");
        Assert.Equal(cursor, reopened!.AuthorityEnvelope["lastAppliedMailboxId"]!.GetValue<long>());
    }

    [Fact]
    public async Task Required_and_cold_local_failures_leave_healthy_owners_available_without_rewriting_bad_authority()
    {
        using var temp = new TempDirectory();
        foreach (var id in new[] { "healthy", "broken", "cold", "missing" })
            await Seed(temp.Path, id, id != "cold");
        var originals = new Dictionary<string, string>();
        foreach (var id in new[] { "broken", "cold" })
        {
            var file = Path.Combine(temp.Path, "state", "sessions", id + ".json");
            var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
            raw["lastAppliedMailboxId"] = -1;
            raw["queue"] = new JsonArray(new JsonObject { ["type"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "retained pending input" }) });
            originals[id] = raw.ToJsonString();
            await File.WriteAllTextAsync(file, originals[id]);
        }
        File.Delete(Path.Combine(temp.Path, "state", "sessions", "missing.json"));
        await using var manager = new SessionManager(temp.Path, Path.Combine(temp.Path, "work"), Options, HostModels.ForTest(Options));
        var reads = new List<string>();
        manager.AdmissionReadObserved = reads.Add;
        await manager.LoadAsync();
        Assert.Equal("healthy", Assert.Single(manager.Owners()).Id);
        Assert.DoesNotContain("cold", reads);
        foreach (var id in new[] { "broken", "cold", "missing" })
        {
            var error = await Assert.ThrowsAsync<SessionAuthorityUnavailableException>(() => manager.RequiredAsync(id));
            Assert.Contains("state/sessions/" + id + ".json", MainLog.SafeFailure(error));
            Assert.Null(manager.Find(id));
            Assert.NotNull(manager.Catalog.Get(id));
        }
        foreach (var (id, original) in originals)
            Assert.Equal(original, await File.ReadAllTextAsync(Path.Combine(temp.Path, "state", "sessions", id + ".json")));
        Assert.False(File.Exists(Path.Combine(temp.Path, "state", "sessions", "missing.json")));
    }

    [Theory]
    [InlineData(AtomicJsonWriteStage.BeforeRename, false)]
    [InlineData(AtomicJsonWriteStage.AfterRenameBeforeDirectorySync, true)]
    public async Task Recovery_save_failure_retains_commit_truth_and_is_not_a_local_read_failure(AtomicJsonWriteStage stage, bool committed)
    {
        using var temp = new TempDirectory();
        await Seed(temp.Path, "busy", required: true);
        var file = Path.Combine(temp.Path, "state", "sessions", "busy.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["busy"] = true;
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        await using var manager = new SessionManager(temp.Path, Path.Combine(temp.Path, "work"), Options, HostModels.ForTest(Options),
            authorityStageHook: (_, observed) => { if (observed == stage) throw new IOException("synthetic-save-failure"); });
        var error = await Record.ExceptionAsync(manager.LoadAsync);
        Assert.NotNull(error);
        Assert.IsNotType<SessionAuthorityUnavailableException>(error);
        Assert.Equal(committed, error is AuthorityCommittedException);
        Assert.Null(manager.Find("busy"));
        Assert.Equal(!committed, JsonNode.Parse(await File.ReadAllTextAsync(file))!["busy"]!.GetValue<bool>());
    }
}
