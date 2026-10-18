using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CliArchiveMigrationTests
{
    [Theory]
    [InlineData("exact")]
    [InlineData("ambiguous")]
    [InlineData("unique")]
    public async Task Migration_preserves_settled_catalog_identity_authority(
        string kind
    )
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

    [Fact]
    public async Task Source_legacy_message_payloads_remain_readable_without_becoming_active_authority()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "native");
        var logs = Path.Combine(root, "state/logs/sessions");
        Directory.CreateDirectory(logs);
        var messages = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "Legacy without inner metadata" }
                ),
            },
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "Historical inner values are not row identity" }
                ),
                ["__meta"] = new JsonObject
                {
                    ["seq"] = 90,
                    ["timestamp"] = 91,
                    ["future"] = "retained",
                },
            },
        };
        var records = messages
            .Select(
                (message, index) =>
                    new JsonObject
                    {
                        ["v"] = 1,
                        ["kind"] = "message",
                        ["sessionId"] = "legacy",
                        ["agent"] = "main",
                        ["seq"] = index + 1,
                        ["timestamp"] = 1001 + index,
                        ["role"] = message["role"]!.DeepClone(),
                        ["message"] = message.DeepClone(),
                    }
            )
            .ToArray();
        var physical = string.Concat(records.Select(record => record.ToJsonString() + "\n"));
        await File.WriteAllTextAsync(Path.Combine(logs, "legacy.jsonl"), physical);
        var sourceRoot = Path.Combine(temp.Path, "source");
        CopyTree(root, sourceRoot);
        var source = await Source("read-legacy", sourceRoot);
        await Migrate(root);
        var archive = new SqliteArchiveMessageStore(Database(root), "legacy");
        var native = archive.ReadMessages();
        Assert.Equal(2, native.Count);
        for (var index = 0; index < native.Count; index++)
        {
            Assert.Equal(index + 1, native[index].Seq);
            Assert.Equal(1001 + index, native[index].Timestamp);
            Assert.True(
                JsonNode.DeepEquals(source["messages"]![index]!["message"], native[index].Message)
            );
            Assert.True(JsonNode.DeepEquals(messages[index], native[index].Message));
        }
        Assert.Throws<InvalidDataException>(() =>
            SessionAuthorityDocument.ValidateMessage(messages[0], 1, "active")
        );
        Assert.Throws<InvalidDataException>(() =>
            ArchiveMessageRecord.Create("legacy", "main", 1, 1001, messages[0])
        );
        // Historical read permission does not authorize replay through the live
        // writer or exact compensation, even when the payload matches storage.
        foreach (var historical in native)
        {
            Assert.Throws<InvalidDataException>(() => archive.WriteMessages([historical]));
            Assert.Throws<InvalidDataException>(() => archive.RollbackInsertedMessages([historical]));
        }
        Assert.Equal(2, archive.ReadMessages().Count);
        archive.WriteBlocks([
            new ArchiveBlockRecord(
                "legacy",
                "main",
                1,
                1,
                "message",
                1,
                2,
                null,
                1,
                2,
                1001,
                1002,
                "Legacy context",
                null,
                1003
            ),
        ]);
        var expanded = new ArchiveContextReader(archive).Expand("legacy", 1, 1000)!;
        Assert.Equal(2, expanded["totalItems"]!.GetValue<int>());
        Assert.Equal(1L, expanded["items"]![0]!["seq"]!.GetValue<long>());
        Assert.Equal(1001, expanded["items"]![0]!["timestamp"]!.GetValue<double>());
        Assert.Equal(
            "Legacy without inner metadata",
            expanded["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>()
        );
        var output = Path.Combine(temp.Path, "export");
        await SqliteArchiveMessageStore.ExportJsonlAsync(Database(root), output);
        var exported = File.ReadAllLines(Path.Combine(output, "legacy.jsonl"))
            .Select(line => JsonNode.Parse(line)!)
            .ToArray();
        Assert.All(
            Enumerable.Range(0, 2),
            index => Assert.True(JsonNode.DeepEquals(messages[index], exported[index]["message"]))
        );
        Assert.Equal(
            physical,
            await File.ReadAllTextAsync(
                Path.Combine(Path.GetDirectoryName(Manifest(root))!, "logs/sessions/legacy.jsonl")
            )
        );
    }
}
