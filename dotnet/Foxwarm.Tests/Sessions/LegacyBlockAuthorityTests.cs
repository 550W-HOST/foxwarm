using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class LegacyBlockAuthorityTests
{
    private static async Task<JsonObject> Source(string mode, string root)
    {
        var repo =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned source fixture root is required.");
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = repo,
                ArgumentList =
                {
                    Path.Combine(repo, "dotnet", "Foxwarm.Tests", "Fixtures", "legacy-block-fixture-ts.mjs"),
                    mode,
                    root,
                },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var text = await stdout;
        Assert.True(process.ExitCode == 0, text + await stderr);
        const string prefix = "LEGACY_BLOCK_FIXTURE:";
        return JsonNode
            .Parse(
                text.Split('\n').Single(line => line.StartsWith(prefix, StringComparison.Ordinal))[
                    prefix.Length..
                ]
            )!
            .AsObject();
    }

    [Fact]
    public async Task Source_legacy_inherited_block_survives_cold_startup_save_compaction_and_reopen_without_fabricated_ids()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var expected = await Source("seed", data);
        var id = expected["childId"]!.GetValue<string>();
        var legacyMeta = expected["inheritedMeta"]!;
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, captured) =>
            {
                var input = JsonNode.Parse(captured.Body)!["input"]!.AsArray();
                var text = string.Join(
                    "\n",
                    input
                        .OfType<JsonObject>()
                        .SelectMany(row =>
                            (row["content"] as JsonArray)?.OfType<JsonObject>() ?? []
                        )
                        .Select(part => SessionWait.Text(part["text"]) ?? "")
                );
                var matches = Regex.Matches(
                    text,
                    "^- M#(\\d+)(?:-#(\\d+))?\\s",
                    RegexOptions.Multiline
                );
                Assert.NotEmpty(matches);
                Assert.DoesNotContain("- B#3 ", text);
                var first = long.Parse(matches[0].Groups[1].Value);
                var last = matches[^1];
                var end = long.Parse(
                    last.Groups[2].Success ? last.Groups[2].Value : last.Groups[1].Value
                );
                var args = new JsonObject
                {
                    ["replaceAsBlocks"] = new JsonArray(
                        new JsonObject
                        {
                            ["level"] = 1,
                            ["sourceKind"] = "message",
                            ["sourceStart"] = first,
                            ["sourceEnd"] = end,
                            ["summary"] = "Synthetic compacted raw work.",
                        }
                    ),
                };
                var payload = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["id"] = "legacy-retention-plan",
                        ["output"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["call_id"] = "submit-plan",
                                ["name"] = "submit_compact_plan",
                                ["arguments"] = args.ToJsonString(),
                            }
                        ),
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + payload.ToJsonString() + "\n\n")
                );
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a/wire", "", "", 20000);
        var models = HostModels.ForTest(options);
        JsonObject[] committed;
        await using (var manager = new SessionManager(data, work, options, models))
        {
            Assert.DoesNotContain(id, manager.Catalog.RestartIds());
            await manager.LoadMainHostAsync();
            Assert.Null(manager.Find(id));
            var owner = await manager.RequiredAsync(id);
            Assert.Equal(
                "synthetic-input-wait",
                SessionWait.Text(owner.Entry.Snapshot().Meta["wait"]?["id"])
            );
            var loaded = owner
                .Entry.Snapshot()
                .History.Single(row =>
                    row.ToJson()["__meta"]?["contextBlock"]?["id"]?.GetValue<long>() == 3
                )
                .ToJson();
            Assert.True(JsonNode.DeepEquals(legacyMeta, loaded["__meta"]!["contextBlock"]));
            await owner.Entry.SaveLane.SaveStrictAsync();
            Assert.True(
                JsonNode.DeepEquals(
                    legacyMeta,
                    JsonNode.Parse(
                        await File.ReadAllTextAsync(
                            Path.Combine(data, "state", "sessions", id + ".json")
                        )
                    )!["history"]![0]!["__meta"]!["contextBlock"]
                )
            );
            var archive = owner.AuthorityStore.Archive;
            var reader = new ArchiveContextReader(archive);
            var expanded = reader.Expand(id, 3, 6000)!;
            Assert.Equal(
                new long[] { 1, 2 },
                expanded["items"]!.AsArray().Select(item => item!["block"]!["id"]!.GetValue<long>())
            );
            Assert.All(
                expanded["items"]!.AsArray(),
                item => Assert.True(item!["inherited"]!.GetValue<bool>())
            );
            Assert.Equal(2, reader.Expand(id, 1, 6000)!["totalItems"]!.GetValue<int>());
            Assert.Null(
                Assert.Single(archive.ReadEffectiveBlocksNumericRange(3, 3)).SourceBlockIds
            );
            var candidates = CompactCandidateBuilder.Build([loaded], keepPercent: 0);
            Assert.Empty(candidates.Items);
            Assert.Empty(candidates.BlockPolicies);
            var current = Enumerable
                .Range(0, 5)
                .Select(index =>
                {
                    var row = (JsonObject)loaded.DeepClone();
                    var block = row["__meta"]!["contextBlock"]!.AsObject();
                    block["id"] = 10 + index;
                    block["sourceBlockIds"] = new JsonArray(1, 2);
                    block["rawStartSeq"] = index * 4 + 1;
                    block["rawEndSeq"] = index * 4 + 4;
                    row["parts"] = new JsonArray(
                        new JsonObject { ["text"] = new string('x', 10000) }
                    );
                    return row;
                })
                .ToArray();
            Assert.Equal(
                expected["currentCandidates"]!.GetValue<int>(),
                CompactCandidateBuilder.Build(current, keepPercent: 0).Items.Count
            );
            var admission = await owner.Compactor.StartManualAsync();
            Assert.True(admission.Started);
            await owner.Compactor.DrainAsync().WaitAsync(TimeSpan.FromSeconds(30));
            Assert.Equal(1, peer.RequestCount);
            var snapshot = owner.Entry.Snapshot();
            Assert.True(
                JsonNode.DeepEquals(
                    legacyMeta,
                    snapshot.History[0].ToJson()["__meta"]!["contextBlock"]
                )
            );
            Assert.NotEmpty(archive.ReadBlocks());
            Assert.Null(reader.Block(3)!.SourceBlockIds);
            committed = snapshot.History.Select(row => row.ToJson()).ToArray();
            await owner.Entry.SaveLane.SaveStrictAsync();
        }
        await using (var reopened = new SessionManager(data, work, options, models))
        {
            await reopened.LoadMainHostAsync();
            var owner = await reopened.RequiredAsync(id);
            Assert.True(
                JsonNode.DeepEquals(
                    new JsonArray(committed.Cast<JsonNode>().ToArray()),
                    new JsonArray(
                        owner
                            .Entry.Snapshot()
                            .History.Select(row => (JsonNode)row.ToJson())
                            .ToArray()
                    )
                )
            );
            Assert.Null(
                new ArchiveContextReader(owner.AuthorityStore.Archive).Block(3)!.SourceBlockIds
            );
        }
        var sourceReopened = await Source("verify", data);
        Assert.True(JsonNode.DeepEquals(legacyMeta, sourceReopened["inheritedMeta"]));
    }

    [Fact]
    public void Legacy_archive_range_replay_is_immutable_and_does_not_relax_raw_message_admission()
    {
        using var temp = new TempDirectory();
        var archive = new SqliteArchiveMessageStore(
            Path.Combine(temp.Path, "archive.sqlite"),
            "origin"
        );
        archive.Initialize();
        archive.EnsureBranch();
        var legacy = new ArchiveBlockRecord(
            "origin",
            "main",
            3,
            2,
            "block",
            1,
            2,
            null,
            1,
            4,
            null,
            null,
            "Synthetic legacy summary.",
            null,
            5000
        );
        Assert.Single(archive.WriteBlocks([legacy]));
        Assert.Empty(archive.WriteBlocks([legacy]));
        Assert.Null(Assert.Single(archive.ReadBlocks()).SourceBlockIds);
        Assert.Throws<InvalidDataException>(() =>
            archive.WriteBlocks([legacy with { Summary = "Conflicting summary." }])
        );
        Assert.Throws<InvalidDataException>(() =>
            archive.WriteBlocks([legacy with { Id = 4, SourceStart = 2, SourceEnd = 1 }])
        );
        var raw = legacy.ToMessage();
        ((JsonObject)raw["__meta"]!)["seq"] = 1;
        Assert.Throws<UnsupportedSessionAuthorityException>(() =>
            ArchiveMessageRecord.Create("origin", "main", 1, 5000, raw)
        );
        Assert.Empty(archive.ReadMessages());
    }

    [Theory]
    [InlineData("descending-absent")]
    [InlineData("null")]
    [InlineData("empty")]
    [InlineData("nonpositive")]
    public async Task Malformed_source_provenance_is_not_legacy_absence(string fault)
    {
        using var temp = new TempDirectory();
        await SessionCatalogMigrationTests.Authority(temp.Path, "branch");
        var root = JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Path.Combine(temp.Path, "state", "sessions", "branch.json")
                )
            )!
            .AsObject();
        var legacy = new ArchiveBlockRecord(
            "origin",
            "main",
            3,
            2,
            "block",
            1,
            2,
            null,
            1,
            4,
            null,
            null,
            "Synthetic legacy summary.",
            null,
            5000
        ).ToMessage();
        var block = legacy["__meta"]!["contextBlock"]!.AsObject();
        if (fault == "descending-absent")
        {
            block["sourceStart"] = 2;
            block["sourceEnd"] = 1;
        }
        else
            block["sourceBlockIds"] = fault switch
            {
                "null" => null,
                "empty" => new JsonArray(),
                _ => new JsonArray(1, 0, 2),
            };
        root["history"] = new JsonArray(legacy);
        root["meta"]!["messageCount"] = 1;
        Assert.Throws<InvalidDataException>(() =>
            SessionAuthorityDocument.FromNode(root, "branch")
        );
    }

    [Fact]
    public void Serialized_null_source_ids_are_not_the_legacy_SQL_null_shape()
    {
        using var temp = new TempDirectory();
        var database = Path.Combine(temp.Path, "archive.sqlite");
        var archive = new SqliteArchiveMessageStore(database, "origin");
        archive.Initialize();
        archive.EnsureBranch();
        archive.WriteBlocks([
            new ArchiveBlockRecord(
                "origin",
                "main",
                3,
                2,
                "block",
                1,
                2,
                null,
                1,
                4,
                null,
                null,
                "Synthetic legacy summary.",
                null,
                5000
            ),
        ]);
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = database, Pooling = false }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText =
            "UPDATE archive_blocks SET source_block_ids_json='null' WHERE session_id='origin' AND id=3";
        command.ExecuteNonQuery();
        Assert.Throws<InvalidDataException>(() => archive.ReadBlocksRange(3, 3));
        Assert.Throws<InvalidDataException>(() => archive.ReadBlocksNumericRange(3, 3));
    }
}
