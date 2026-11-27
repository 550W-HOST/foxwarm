using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CliArchiveMigrationTests
{
    [Theory]
    [InlineData("exact")]
    [InlineData("ambiguous")]
    [InlineData("unique")]
    public async Task Migration_preserves_settled_catalog_identity_authority(string kind)
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(root, "state/sessions"));
        JsonObject Row(string id, params string[] aliases) =>
            new()
            {
                ["id"] = id,
                ["agent"] = "main",
                ["aliases"] = new JsonArray(
                    aliases.Select(alias => (JsonNode?)JsonValue.Create(alias)).ToArray()
                ),
                ["busy"] = false,
                ["queueLength"] = 0,
                ["meta"] = new JsonObject { ["lastMessageTime"] = 0, ["messageCount"] = 0 },
            };
        var alias = kind == "exact" ? "exact" : "shared";
        var rows = new JsonObject { ["alpha"] = Row("alpha", alias) };
        if (kind != "unique")
        {
            var other = kind == "exact" ? "exact" : "beta";
            rows[other] = kind == "ambiguous" ? Row(other, alias) : Row(other);
        }
        foreach (var (id, _) in rows)
            await File.WriteAllTextAsync(
                Path.Combine(root, "state/sessions", id + ".json"),
                "{\"history\":[],\"agent\":\"main\"}"
            );
        await File.WriteAllTextAsync(
            Path.Combine(root, "state/sessions.json"),
            new JsonObject { ["sessions"] = rows }.ToJsonString()
        );
        using var catalog = new SessionCatalog(root);
        catalog.Initialize(); // The real accepted legacy catalog import, including retired metadata.
        await new CommittedArchiveIdentity(root).InitializeAsync(catalog);
        var store = new SqliteArchiveMessageStore(
            Database(root),
            kind == "exact" ? "exact" : "alpha"
        );
        store.Initialize();
        var expected = kind == "unique" ? "alpha" : alias;
        var historical = new SqliteArchiveMessageStore(Database(root), alias);
        Assert.Equal(expected, historical.CanonicalSessionId);
        await Migrate(root);
        Assert.Equal(expected, historical.CanonicalSessionId);
        store.Initialize();
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "Exact binding stays writable" }),
            ["__meta"] = new JsonObject { ["seq"] = 1, ["timestamp"] = 1001 },
        };
        Assert.Single(
            store.WriteMessages([
                ArchiveMessageRecord.Create(store.CanonicalSessionId, "main", 1, 1001, message),
            ])
        );
        if (kind == "unique")
        {
            Assert.Throws<InvalidOperationException>(historical.Initialize);
            Assert.Single(historical.ReadMessages());
        }
        else if (kind == "ambiguous")
            Assert.Empty(historical.ReadMessages());
        else
            Assert.Equal("exact", historical.ReadMessages().Single().SessionId);
    }
}
