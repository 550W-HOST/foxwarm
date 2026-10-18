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
            catalogPath = seed.Catalog.FilePath;
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
        var journal = new SessionIdentityMoveJournal(data);
        var database = Path.Combine(data, "state/archive-store.sqlite");
        journal.MoveArtifacts("old", "new");
        SqliteArchiveIdentityMove.Rename(database, "old", "new");
        journal.Write(new("rolling-back", "old", "new", "main", [], false, null, 1000));
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
        Assert.Null(new SqliteArchiveMessageStore(database, "new").ReadBranch());
        Assert.False(File.Exists(journal.FilePath));
    }

    [Theory]
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
        string catalogPath;
        await using (var seed = Manager(data, work))
        {
            await seed.LoadAsync();
            var owner = await seed.CreateNamedAsync("main", "old", null, null);
            await ForkClearLifecycleTests.AppendAsync(owner, Text("Retained byte proof"));
            catalogPath = seed.Catalog.FilePath;
            if (mode == "other-lifetime")
            {
                await seed.CreateAgentAsync("claimed", false, null);
                await seed.CreateNamedAsync("claimed", "foreign", null, null);
            }
        }
        var journal = new SessionIdentityMoveJournal(data);
        var original = await File.ReadAllBytesAsync(journal.AuthorityPath("old"));
        var audit = new SqliteArchiveMessageStore(
            Path.Combine(data, "state", "archive-store.sqlite"),
            "old"
        )
            .ReadMessages()
            .Single()
            .MessageJson;
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
        if (mode == "ambiguous")
        {
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
        journal.Write(record);
        var metadata = await File.ReadAllBytesAsync(catalogPath);
        await Assert.ThrowsAnyAsync<InvalidDataException>(async () =>
        {
            await using var rejected = Manager(data, work);
            await rejected.LoadAsync();
        });
        Assert.Equal(original, await File.ReadAllBytesAsync(journal.AuthorityPath("old")));
        Assert.Equal(metadata, await File.ReadAllBytesAsync(catalogPath));
        Assert.Equal(
            audit,
            new SqliteArchiveMessageStore(
                Path.Combine(data, "state", "archive-store.sqlite"),
                "old"
            )
                .ReadMessages()
                .Single()
                .MessageJson
        );
        Assert.True(File.Exists(journal.FilePath));
        Assert.True(Directory.Exists(claimed));
        Assert.Equal(
            "Other directory byte proof",
            await File.ReadAllTextAsync(Path.Combine(outside, "keep.txt"))
        );
    }
}
