using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests;

public sealed class FileSessionAuthorityBackendTests
{
    [Fact]
    public async Task Reads_report_absence_without_creating_authority()
    {
        using var temp = new TempDirectory();
        var backend = new FileStorageContext(temp.Path).Authority;
        Assert.False(backend.Exists("s"));
        Assert.Null(backend.ReadEnvelope("s", "main"));
        Assert.Null(await backend.ReadRawAsync("s"));
        Assert.False(Directory.Exists(Path.Combine(temp.Path, "state", "sessions")));
    }

    [Fact]
    public async Task Envelope_and_raw_reads_return_the_committed_document()
    {
        using var temp = new TempDirectory();
        var backend = new FileStorageContext(temp.Path).Authority;
        var store = backend.Open("s", "main", new SessionAuthorityCallbacks());
        await store.CommitAsync(Snapshot("s", "first"), SaveKind.Strict);

        Assert.True(backend.Exists("s"));
        var envelope = backend.ReadEnvelope("s", "main")!;
        Assert.Null(envelope["history"]);
        Assert.Equal(2, envelope["nextMessageSeq"]!.GetValue<long>());

        var raw = (await backend.ReadRawAsync("s"))!;
        Assert.Equal(store.AuthorityPath(), raw.Locator);
        Assert.True(
            JsonNode.DeepEquals(
                JsonNode.Parse(await File.ReadAllTextAsync(store.AuthorityPath())),
                raw.Document
            )
        );
        Assert.Equal("first", raw.Document!["history"]![0]!["parts"]![0]!["text"]!.GetValue<string>());
    }

    [Fact]
    public async Task Envelope_read_validates_like_a_load()
    {
        using var temp = new TempDirectory();
        var backend = new FileStorageContext(temp.Path).Authority;
        var path = Path.Combine(temp.Path, "state", "sessions", "s.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, "[]");
        Assert.ThrowsAny<Exception>(() => backend.ReadEnvelope("s", "main"));
        // The raw view shows any stored JSON value; the debug route decides what it accepts.
        Assert.IsType<JsonArray>((await backend.ReadRawAsync("s"))!.Document);
    }

    [Fact]
    public async Task Identity_move_and_raw_replacement_keep_the_stored_value()
    {
        using var temp = new TempDirectory();
        var backend = new FileStorageContext(temp.Path).Authority;
        var store = backend.Open("old", "main", new SessionAuthorityCallbacks());
        await store.CommitAsync(Snapshot("old", "kept"), SaveKind.Strict);
        var before = await File.ReadAllBytesAsync(store.AuthorityPath());

        backend.MoveIdentity("old", "new");
        Assert.False(backend.Exists("old"));
        Assert.Equal(
            before,
            await File.ReadAllBytesAsync(Path.Combine(temp.Path, "state", "sessions", "new.json"))
        );
        // A replayed move whose source is already gone changes nothing.
        backend.MoveIdentity("old", "new");
        Assert.True(backend.Exists("new"));

        var raw = (JsonObject)(await backend.ReadRawAsync("new"))!.Document!;
        raw["id"] = "new";
        raw["futureField"] = "untouched";
        backend.ReplaceRaw("new", raw);
        Assert.True(
            JsonNode.DeepEquals(raw, (await backend.ReadRawAsync("new"))!.Document)
        );
    }

    [Fact]
    public async Task Deletes_report_removal_before_returning_and_tolerate_absence()
    {
        using var temp = new TempDirectory();
        var backend = new FileStorageContext(temp.Path).Authority;
        var store = backend.Open("s", "main", new SessionAuthorityCallbacks());
        await store.CommitAsync(Snapshot("s", "gone"), SaveKind.Strict);
        var frontier = Path.Combine(temp.Path, "state", "sessions", "s.frontier.json");
        await File.WriteAllTextAsync(frontier, "{}");

        var stages = new List<string>();
        backend.DeleteAuthority(
            "s",
            () => stages.Add(File.Exists(store.AuthorityPath()) ? "visible" : "removed")
        );
        backend.DeleteLegacyArtifacts(
            "s",
            () => stages.Add(File.Exists(frontier) ? "visible" : "removed")
        );
        Assert.Equal(["removed", "removed"], stages);
        Assert.False(backend.Exists("s"));
        Assert.False(File.Exists(frontier));

        backend.DeleteAuthority("s");
        backend.DeleteLegacyArtifacts("s");
    }

    private static SessionSnapshot Snapshot(string id, string text) =>
        new(
            id,
            [
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
                    ["__meta"] = new JsonObject { ["seq"] = 1, ["timestamp"] = 1000 },
                },
            ],
            [],
            false,
            null,
            false,
            new JsonObject { ["lastMessageTime"] = 1000, ["messageCount"] = 1 },
            2,
            1,
            new JsonObject()
        );
}
