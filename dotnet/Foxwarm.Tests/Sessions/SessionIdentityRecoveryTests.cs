using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionIdentityRecoveryTests
{
    private static JsonObject Text(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static SessionManager Manager(string data, string work) =>
        new(data, work, Options, HostModels.ForTest(Options));

    [Theory]
    [InlineData("rolling-back", 1)]
    [InlineData("finishing", 1)]
    [InlineData("rolling-back", 2)]
    [InlineData("finishing", 2)]
    public async Task Directional_recovery_selects_existing_legacy_metadata_before_ordinary_source_migration(
        string phase,
        int version
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        string catalogPath;
        JsonObject row;
        await using (var seed = Manager(data, work))
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "old", null, null);
            await ForkClearLifecycleTests.AppendAsync(owner, Text("Original immutable audit"));
            row = seed.Catalog.Get("old")!;
            catalogPath = seed.Catalog.File().FilePath;
        }
        File.Delete(catalogPath);
        File.Delete(catalogPath + "-wal");
        File.Delete(catalogPath + "-shm");
        var journal = new SessionIdentityMoveJournal(data);
        var database = Path.Combine(data, "state", "archive-store.sqlite");
        var originalImages = Path.Combine(data, "state", "sessions-blob", "old.images");
        var targetImages = Path.Combine(data, "state", "sessions-blob", "new.images");
        Directory.CreateDirectory(originalImages);
        await File.WriteAllTextAsync(
            Path.Combine(originalImages, "retained.txt"),
            "Original legacy bytes."
        );
        journal.MoveArtifacts("old", "new", version);
        SqliteArchiveIdentityMove.Rename(database, "old", "new");
        if (phase == "finishing")
        {
            row["id"] = "new";
            row["aliases"] = new JsonArray("old");
            var raw = JsonNode
                .Parse(await File.ReadAllTextAsync(journal.AuthorityPath("new")))!
                .AsObject();
            if (raw.ContainsKey("id"))
                raw["id"] = "new";
            await File.WriteAllTextAsync(journal.AuthorityPath("new"), raw.ToJsonString());
        }
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "sessions.json"),
            new JsonObject
            {
                ["sessions"] = new JsonObject { [phase == "finishing" ? "new" : "old"] = row },
            }.ToJsonString()
        );
        journal.Write(new(phase, "old", "new", "main", [], false, null, 1000, version));
        await using var recovered = Manager(data, work);
        await recovered.LoadMainHostAsync();
        var ownerAfter = await recovered.RequiredAsync("old");
        Assert.Equal(phase == "finishing" ? "new" : "old", ownerAfter.Id);
        Assert.Equal(
            "Original immutable audit",
            ownerAfter.Entry.Snapshot().History[0].ToJson()["parts"]![0]![
                "text"
            ]!.GetValue<string>()
        );
        Assert.Single(ownerAfter.Archive.ReadMessages());
        Assert.Equal(ownerAfter.Id, ownerAfter.Archive.ReadMessages().Single().SessionId);
        Assert.False(File.Exists(journal.FilePath));
        var retainedImages = version == 1 && phase == "finishing" ? targetImages : originalImages;
        Assert.Equal(
            "Original legacy bytes.",
            await File.ReadAllTextAsync(Path.Combine(retainedImages, "retained.txt"))
        );
        Assert.Equal(version == 1 && phase == "finishing", Directory.Exists(targetImages));
        Assert.True(File.Exists(catalogPath));
        Assert.True(
            File.Exists(Path.Combine(data, "state", "sessions.json.pre-catalog-sqlite-v1.bak"))
        );
        if (phase == "finishing")
            await Assert.ThrowsAsync<InvalidDataException>(() =>
                recovered.CreateNamedAsync("main", "old", null, null)
            );
    }

    [Fact]
    [Trait("Backend", "neutral")]
    public async Task First_ordinary_startup_preserves_pending_rollback_with_an_existing_exact_catalog_binding()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        await using (var seed = Manager(data, work))
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "old", null, null);
            await ForkClearLifecycleTests.AppendAsync(owner, Text("Pending rollback audit"));
        }
        IdentityTestStorage.MoveStoredIdentity(data, "old", "new");
        IdentityTestStorage.Open(data)
            .Identities.WritePendingMove(new("rolling-back", "old", "new", "main", [], false, null, 1000));
        await using var recovered = Manager(data, work);
        await recovered.LoadMainHostAsync();
        var ownerAfter = await recovered.RequiredAsync("old");
        Assert.Equal("old", ownerAfter.Id);
        Assert.Equal("old", ownerAfter.Archive.ReadMessages().Single().SessionId);
        Assert.Equal(
            "Pending rollback audit",
            ownerAfter.Archive.ReadMessages().Single().Message["parts"]![0]![
                "text"
            ]!.GetValue<string>()
        );
        Assert.Null(IdentityTestStorage.Archive(data, "new").ReadBranch());
        Assert.False(IdentityTestStorage.PendingMove(data));
    }

    [Theory]
    [Trait("Backend", "neutral")]
    [InlineData("rolling-back", false)]
    [InlineData("rolling-back", true)]
    [InlineData("finishing", false)]
    [InlineData("finishing", true)]
    public async Task Late_catalog_move_keeps_recovery_direction_before_alias_commit(
        string phase,
        bool ordinaryStartup
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        await using (var seed = Manager(data, work))
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "old", null, null);
            await ForkClearLifecycleTests.AppendAsync(owner, Text("Late catalog audit"));
        }
        var storage = IdentityTestStorage.Open(data);
        storage.Identities.WritePendingMove(new("rolling-back", "old", "new", "main", [], false, null, 1000));
        // ExecuteIdentityMoveAsync publishes these outputs before changing the
        // journal to finishing and committing the old-to-new alias.
        IdentityTestStorage.MoveStoredIdentity(data, "old", "new");
        var raw = await IdentityTestStorage.RawAuthority(data, "new");
        raw["id"] = "new";
        raw["agent"] = "main";
        raw["aliases"] = new JsonArray("old");
        storage.Authority.ReplaceRaw("new", raw);
        storage.Catalog.RewriteIdentity("old", "new", "main", ["old"]);
        if (storage.Catalog is IDisposable disposable)
            disposable.Dispose();
        if (phase == "finishing")
            storage.Identities.WritePendingMove(new(phase, "old", "new", "main", [], false, null, 1000));

        await using var recovered = Manager(data, work);
        if (ordinaryStartup)
            await recovered.LoadMainHostAsync();
        else
            await recovered.LoadAsync();
        var ownerAfter = await recovered.RequiredAsync("old");
        var expected = phase == "rolling-back" ? "old" : "new";
        Assert.Equal(expected, ownerAfter.Id);
        var audit = Assert.Single(ownerAfter.Archive.ReadMessages());
        Assert.Equal(expected, audit.SessionId);
        Assert.Equal("Late catalog audit", audit.Message["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal(expected, IdentityTestStorage.Archive(data, "old").CanonicalSessionId);
        if (phase == "rolling-back")
            Assert.Null(IdentityTestStorage.Archive(data, "new").ReadBranch());
        Assert.False(IdentityTestStorage.PendingMove(data));
    }

    [Theory]
    [Trait("Backend", "neutral")]
    [InlineData("owned-name")]
    [InlineData("old-agent")]
    [InlineData("symlink")]
    [InlineData("other-lifetime")]
    [InlineData("ambiguous")]
    public async Task Invalid_ownership_or_exact_lifetime_proof_preserves_other_directories_and_immutable_authority(
        string mode
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        string? catalogPath;
        await using (var seed = Manager(data, work))
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "old", null, null);
            await ForkClearLifecycleTests.AppendAsync(owner, Text("Retained byte proof"));
            catalogPath = (seed.Storage.Catalog as SessionCatalog)?.FilePath;
            if (mode == "other-lifetime")
            {
                await seed.CreateAgentAsync("claimed", false, null);
                await seed.CreateNamedAsync("claimed", "foreign", null, null);
            }
        }
        var original = await IdentityTestStorage.AuthorityText(data, "old");
        var audit = IdentityTestStorage.Archive(data, "old").ReadMessages().Single().MessageJson;
        var outside = Path.Combine(temp.Path, "outside");
        Directory.CreateDirectory(outside);
        await File.WriteAllTextAsync(
            Path.Combine(outside, "keep.txt"),
            "Other directory byte proof"
        );
        var claimed = Path.Combine(work, "agents", "claimed");
        if (mode == "symlink")
            Directory.CreateSymbolicLink(claimed, outside);
        else if (!Directory.Exists(claimed))
            Directory.CreateDirectory(claimed);
        var storage = IdentityTestStorage.Open(data);
        if (mode == "ambiguous")
        {
            // Seeds a catalog row directly; a hosted catalog needs its own seeding helper.
            Assert.IsType<SessionCatalog>(storage.Catalog);
            using var catalog = new SessionCatalog(data);
            catalog.Initialize();
            catalog.Upsert([SessionCatalogTests.Row("claimed/main", 0)]);
        }
        var record = new SessionIdentityMoveRecord(
            "rolling-back",
            "old",
            "claimed/main",
            mode == "old-agent" ? "foreign" : "main",
            [],
            true,
            mode == "owned-name" ? "unrelated" : "claimed",
            1000
        );
        storage.Identities.WritePendingMove(record);
        // The catalog file's bytes in file mode; the catalog rows otherwise.
        async Task<string> Metadata() =>
            catalogPath is null
                ? new JsonArray(storage.Catalog.List().Select(row => (JsonNode)row.DeepClone()).ToArray()).ToJsonString()
                : Convert.ToBase64String(await File.ReadAllBytesAsync(catalogPath));
        var metadata = await Metadata();
        await Assert.ThrowsAnyAsync<InvalidDataException>(async () =>
        {
            await using var rejected = Manager(data, work);
            await rejected.LoadAsync();
        });
        Assert.Equal(original, await IdentityTestStorage.AuthorityText(data, "old"));
        Assert.Equal(metadata, await Metadata());
        Assert.Equal(audit, IdentityTestStorage.Archive(data, "old").ReadMessages().Single().MessageJson);
        Assert.True(IdentityTestStorage.PendingMove(data));
        Assert.True(Directory.Exists(claimed));
        Assert.Equal(
            "Other directory byte proof",
            await File.ReadAllTextAsync(Path.Combine(outside, "keep.txt"))
        );
    }
}
