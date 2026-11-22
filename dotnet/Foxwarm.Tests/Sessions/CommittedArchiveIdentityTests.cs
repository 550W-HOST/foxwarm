using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class CommittedArchiveIdentityTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private static SessionManager Manager(string root, string work) =>
        new(root, work, Options, HostModels.ForTest(Options));

    private static SqliteConnection Open(string file, bool readOnly = false)
    {
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = file,
                Mode = readOnly ? SqliteOpenMode.ReadOnly : SqliteOpenMode.ReadWrite,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        return connection;
    }

    private static void Execute(string file, string sql)
    {
        using var connection = Open(file);
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static JsonArray Records(IEnumerable<ArchiveMessageRecord> records) =>
        new(
            records
                .Select(row =>
                    (JsonNode)
                        new JsonObject
                        {
                            ["sessionId"] = row.SessionId,
                            ["agent"] = row.Agent,
                            ["seq"] = row.Seq,
                            ["timestamp"] = row.Timestamp,
                            ["role"] = row.Role,
                            ["messageJson"] = row.MessageJson,
                        }
                )
                .ToArray()
        );

    private static void Blocks(JsonArray expected, IReadOnlyList<ArchiveBlockRecord> actual)
    {
        Assert.Equal(expected.Count, actual.Count);
        for (var i = 0; i < actual.Count; i++)
        {
            var row = expected[i]!;
            var block = actual[i];
            Assert.Equal(row["sessionId"]!.GetValue<string>(), block.SessionId);
            Assert.Equal(row["agent"]!.GetValue<string>(), block.Agent);
            Assert.Equal(row["id"]!.GetValue<long>(), block.Id);
            Assert.Equal(row["summary"]!.GetValue<string>(), block.Summary);
            Assert.Equal(row["createdAt"]!.GetValue<long>(), block.CreatedAt);
            Assert.Equal(row["sourceStart"]!.GetValue<long>(), block.SourceStart);
            Assert.Equal(row["sourceEnd"]!.GetValue<long>(), block.SourceEnd);
        }
    }

    [Fact]
    public async Task Backfill_uses_exact_first_unique_unshadowed_metadata_and_preserves_idempotent_committed_chain_and_exact_strings()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            var rows = Enumerable
                .Range(0, 1000)
                .Select(i => SessionCatalogTests.Row("cold-" + i, 0))
                .ToList();
            var alpha = SessionCatalogTests.Row("alpha", 0);
            alpha["aliases"] = new JsonArray("old", " whitespace ", "alpha", "shared", "exact");
            var beta = SessionCatalogTests.Row("beta", 0);
            beta["aliases"] = new JsonArray("shared");
            rows.AddRange([alpha, beta, SessionCatalogTests.Row("exact", 0)]);
            catalog.Upsert(rows.ToArray());
        }
        var ledger = Path.Combine(data, "state", "session-id-reservations.jsonl");
        await File.WriteAllTextAsync(
            ledger,
            "{\"v\":1,\"sessionId\":\"old\",\"canonicalSessionId\":\"middle\"}\n{\"v\":1,\"sessionId\":\"middle\",\"canonicalSessionId\":\"alpha\"}\n"
        );
        await using var manager = Manager(data, work);
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        Assert.Equal(1003, manager.Catalog.List().Length);
        using var connection = Open(Path.Combine(data, "state", "archive-store.sqlite"), true);
        using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT session_id,canonical_session_id FROM archive_session_id_reservations";
        using var records = command.ExecuteReader();
        var mappings = new Dictionary<string, string>();
        while (records.Read())
            mappings[records.GetString(0)] = records.GetString(1);
        Assert.Equal("middle", mappings["old"]);
        Assert.Equal("alpha", mappings["middle"]);
        Assert.Equal("alpha", mappings[" whitespace "]);
        Assert.Equal("alpha", mappings["alpha"]);
        Assert.False(mappings.ContainsKey("shared"));
        Assert.False(mappings.ContainsKey("exact"));
        Assert.Equal("ambiguous", manager.Catalog.Resolve("shared")["kind"]!.GetValue<string>());
        Assert.Equal("exact", manager.Catalog.Resolve("exact")["sessionId"]!.GetValue<string>());
        Assert.False(Directory.Exists(Path.Combine(data, "state", "sessions")));
    }

    [Theory]
    [InlineData("conflict")]
    [InlineData("cycle")]
    [InlineData("metadata-conflict")]
    public async Task Conflicting_or_cyclic_committed_authority_fails_before_main_owner_and_retained_queue_deadline_changes_and_retries(
        string kind
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            var row = SessionCatalogTests.Row("queued", 0);
            row["queueLength"] = 1;
            row["aliases"] = new JsonArray("old");
            catalog.Upsert([row]);
        }
        await SessionCatalogMigrationTests.Authority(data, "queued");
        var file = Path.Combine(data, "state", "sessions", "queued.json");
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["queue"] = new JsonArray(
            new JsonObject
            {
                ["type"] = "onboot",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["system"] = "Must not reach a provider before identity validation.",
                    }
                ),
            }
        );
        raw["wait"] = new JsonObject
        {
            ["id"] = "expired",
            ["startedAt"] = 1,
            ["timeoutSeconds"] = 1,
            ["declarationVersion"] = 1,
        };
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        var before = await File.ReadAllBytesAsync(file);
        var ledger = Path.Combine(data, "state", "session-id-reservations.jsonl");
        var content = kind switch
        {
            "conflict" =>
                "{\"v\":1,\"sessionId\":\"old\",\"canonicalSessionId\":\"queued\"}\n{\"v\":1,\"sessionId\":\"old\",\"canonicalSessionId\":\"other\"}\n",
            "cycle" =>
                "{\"v\":1,\"sessionId\":\"a\",\"canonicalSessionId\":\"b\"}\n{\"v\":1,\"sessionId\":\"b\",\"canonicalSessionId\":\"a\"}\n",
            _ => "{\"v\":1,\"sessionId\":\"old\",\"canonicalSessionId\":\"other\"}\n",
        };
        await File.WriteAllTextAsync(ledger, content);
        await using var manager = Manager(data, work);
        await Assert.ThrowsAsync<InvalidDataException>(manager.LoadMainHostAsync);
        Assert.Empty(manager.Owners());
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "main.json")));
        Assert.Equal(before, await File.ReadAllBytesAsync(file));
        Assert.Equal(content, await File.ReadAllTextAsync(ledger));
        await File.WriteAllTextAsync(ledger, "");
        Execute(
            Path.Combine(data, "state", "archive-store.sqlite"),
            "DELETE FROM archive_session_id_reservations"
        );
        using var catalog2 = new SessionCatalog(data);
        var row2 = SessionCatalogTests.Row("queued", 0);
        catalog2.Initialize();
        catalog2.Upsert([row2]);
        await manager.LoadAsync();
        Assert.Empty(manager.Owners());
        Assert.Equal(before, await File.ReadAllBytesAsync(file));
    }
}
