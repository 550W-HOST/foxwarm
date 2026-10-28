using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SessionCatalogMigrationTests
{
    [Fact]
    public async Task Source_migration_uses_current_authority_semantics_and_exact_catalog_membership_then_retires_candidates()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        await Authority(root, "one");
        await Authority(root, "orphan");
        var path = Path.Combine(root, "state", "sessions", "one.json");
        var current = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        current["model"] = "current";
        current["displayName"] = "old-context-copy";
        await File.WriteAllTextAsync(path, current.ToJsonString());
        var row = SessionCatalogTests.Row("one", 100);
        row["displayName"] = "Catalog name";
        row["model"] = "stale";
        row["queue"] = new JsonArray("stale catalog queue");
        row["promptCacheKey"] = "stale cache";
        var legacy = new JsonObject { ["sessions"] = new JsonObject { ["one"] = row } };
        var selected = Path.Combine(root, "state", "sessions.json");
        var bytes = legacy.ToJsonString();
        await File.WriteAllTextAsync(selected, bytes);
        await File.WriteAllTextAsync(selected + ".1.bak", "invalid old backup");
        using var catalog = new SessionCatalog(root);
        catalog.Initialize();
        Assert.Single(catalog.List());
        Assert.Equal("current", catalog.Get("one")!["model"]!.GetValue<string>());
        Assert.Equal("Catalog name", catalog.Get("one")!["displayName"]!.GetValue<string>());
        Assert.Equal(bytes, await File.ReadAllTextAsync(selected + ".pre-catalog-sqlite-v1.bak"));
        Assert.False(File.Exists(selected));
        Assert.False(File.Exists(selected + ".1.bak"));
        Assert.Equal(current.ToJsonString(), await File.ReadAllTextAsync(path));
        Assert.Equal("missing", catalog.Resolve("orphan")["kind"]!.GetValue<string>());
        Assert.DoesNotContain("cache", catalog.Get("one")!.ToJsonString());
        catalog.Dispose();
        await File.WriteAllTextAsync(selected, "do-not-replay");
        using var reopened = new SessionCatalog(root);
        reopened.Initialize();
        Assert.Single(reopened.List());
        Assert.Equal("do-not-replay", await File.ReadAllTextAsync(selected));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("corrupt")]
    [InlineData("version")]
    [InlineData("unsupported")]
    public async Task A_selected_authority_failure_never_falls_back_to_an_older_catalog(string kind)
    {
        using var temp = new TempDirectory();
        var root = temp.Path;
        await Authority(root, "bad");
        await Authority(root, "good");
        var file = Path.Combine(root, "state", "sessions", "bad.json");
        if (kind == "missing")
            File.Delete(file);
        else if (kind == "corrupt")
            await File.WriteAllTextAsync(file, "{bad");
        else
        {
            var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
            if (kind == "version")
                raw["sessionStateVersion"] = 2;
            else
                raw["lastAppliedMailboxId"] = -1;
            await File.WriteAllTextAsync(file, raw.ToJsonString());
        }
        await WriteCandidate(root, "bad");
        await WriteCandidate(root, "good", ".1.bak");
        using var catalog = new SessionCatalog(root);
        catalog.Initialize();
        Assert.NotNull(catalog.Get("bad"));
        Assert.Null(catalog.Get("good"));
        Assert.True(File.Exists(catalog.FilePath));
        Assert.True(File.Exists(Path.Combine(root, "state", "sessions.json.pre-catalog-sqlite-v1.bak")));
    }

    [Fact]
    public async Task Structural_candidate_fallback_and_supported_unversioned_upgrade_preserve_the_selected_evidence()
    {
        using var temp = new TempDirectory();
        await Authority(temp.Path, "one");
        var authorityPath = Path.Combine(temp.Path, "state", "sessions", "one.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(authorityPath))!.AsObject();
        raw.Remove("sessionStateVersion");
        raw.Remove("model");
        raw["stats"]!["totalInputTokens"] = 21;
        raw["meta"]!["lastChannel"] = new JsonObject
        {
            ["platform"] = "legacy",
            ["conversationId"] = "room",
        };
        await File.WriteAllTextAsync(authorityPath, raw.ToJsonString());
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "sessions.json"),
            "{bad-candidate"
        );
        var row = SessionCatalogTests.Row("one", 0);
        row["model"] = "transferred";
        row["stats"] = new JsonObject { ["totalInputTokens"] = 99, ["totalOutputTokens"] = 7 };
        row["meta"]!["lastChannel"] = raw["meta"]!["lastChannel"]!.DeepClone();
        await WriteCandidate(temp.Path, row, ".1.bak");
        var selected = await File.ReadAllTextAsync(
            Path.Combine(temp.Path, "state", "sessions.json.1.bak")
        );
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        var upgraded = JsonNode.Parse(await File.ReadAllTextAsync(authorityPath))!;
        Assert.Equal(1, upgraded["sessionStateVersion"]!.GetValue<int>());
        Assert.Equal("transferred", upgraded["model"]!.GetValue<string>());
        Assert.Equal(21, upgraded["stats"]!["totalInputTokens"]!.GetValue<int>());
        Assert.Equal(0, upgraded["stats"]!["totalOutputTokens"]!.GetValue<int>());
        Assert.Null(upgraded["meta"]!["lastChannel"]);
        Assert.Equal(
            "legacy",
            catalog.Get("one")!["meta"]!["lastChannel"]!["channelId"]!.GetValue<string>()
        );
        Assert.Equal(
            selected,
            await File.ReadAllTextAsync(
                Path.Combine(temp.Path, "state", "sessions.json.pre-catalog-sqlite-v1.bak")
            )
        );
    }

    [Fact]
    public async Task Missing_catalog_cannot_be_reconstructed_from_authority_files()
    {
        using var temp = new TempDirectory();
        await Authority(temp.Path, "one");
        using var catalog = new SessionCatalog(temp.Path);
        Assert.Throws<InvalidDataException>(catalog.Initialize);
        Assert.False(File.Exists(catalog.FilePath));
    }

    [Fact]
    public async Task Catalog_membership_does_not_admit_orphan_files_or_replace_a_missing_authority()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await Authority(root, "one");
        await WriteCandidate(root, "one");
        using var catalog = new SessionCatalog(root);
        catalog.Initialize();
        var path = Path.Combine(root, "state", "sessions", "one.json");
        // Catalog membership now proves retained IDs versus expected authority; it is not rebuilt from files.
        await Authority(root, "orphan");
        Assert.Equal("missing", catalog.Resolve("orphan")["kind"]!.GetValue<string>());
        File.Delete(path);
        var options = new Foxwarm.Models.ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a/wire",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            root,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        await Assert.ThrowsAsync<SessionAuthorityUnavailableException>(() => manager.RequiredAsync("one"));
    }

    [Fact]
    public async Task Evidence_conflict_is_fatal_and_leaves_authority_and_candidates_untouched()
    {
        using var temp = new TempDirectory();
        await Authority(temp.Path, "one");
        var path = Path.Combine(temp.Path, "state", "sessions", "one.json");
        var original = await File.ReadAllTextAsync(path);
        await WriteCandidate(temp.Path, "one");
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "sessions.json.pre-catalog-sqlite-v1.bak"),
            "different evidence"
        );
        using var catalog = new SessionCatalog(temp.Path);
        Assert.Throws<IOException>(catalog.Initialize);
        Assert.False(File.Exists(catalog.FilePath));
        Assert.Equal(original, await File.ReadAllTextAsync(path));
        Assert.True(File.Exists(Path.Combine(temp.Path, "state", "sessions.json")));
    }

    internal static async Task Authority(string root, string id)
    {
        var store = new PersistentSessionAuthorityStore(root, id);
        var registry = new SessionRegistry(store, new ControlledChat());
        var entry = registry.Add(id);
        await entry.SaveLane.SaveStrictAsync();
    }

    private static Task WriteCandidate(string root, string id, string suffix = "") =>
        WriteCandidate(root, SessionCatalogTests.Row(id, 0), suffix);

    private static Task WriteCandidate(string root, JsonObject row, string suffix = "") =>
        File.WriteAllTextAsync(
            Path.Combine(root, "state", "sessions.json" + suffix),
            new JsonObject
            {
                ["sessions"] = new JsonObject { [row["id"]!.GetValue<string>()] = row },
            }.ToJsonString()
        );
}
