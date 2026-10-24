using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionPresentationTests
{
    [Fact]
    public async Task Actual_source_locale_order_and_normal_route_results_match()
    {
        using var temp = new TempDirectory();
        var repository = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var ids = new[]
        {
            "a",
            "A",
            "a-a",
            "a_a",
            "a/a",
            "a.a",
            "a10",
            "a2",
            "á",
            "À",
            "ä",
            "ae",
            "é",
            "e\u0301",
            "İ",
            "ı",
            "Σ",
            "σ",
            "ς",
            "Ж",
            "中",
            "𐐀",
            "😀",
            "z",
            "Z",
        };
        var rows = ids.Select(id => SessionCatalogTests.Row(id, 0, "root")).ToList();
        rows.Add(SessionCatalogTests.Row("root", 0));
        rows.Add(SessionCatalogTests.Row("other", 0));
        rows.Add(SessionCatalogTests.Row("space-child", 0, " \uFEFFroot\u00A0 "));
        rows.Add(SessionCatalogTests.Row("P", 0, aliases: ["pAlias"]));
        rows.Add(SessionCatalogTests.Row("alias-anchor", 0, "pAlias"));
        rows.Add(SessionCatalogTests.Row("orphan-anchor", 0, "missing-parent"));
        rows.Add(SessionCatalogTests.Row("old-orphan", 0, "missing-parent"));
        rows.Add(SessionCatalogTests.Row("mover", 0, "other"));
        rows[2]["archived"] = true;
        rows[4]["sidebarOrder"] = -0.5;
        rows[8]["sidebarOrder"] = 3;
        rows[12]["meta"]!["lastMessageTime"] = 20;
        rows[0]["aliases"] = new JsonArray("unique-a");
        var operations = new JsonArray(
            new JsonObject
            {
                ["action"] = "pin",
                ["id"] = "unique-a",
                ["body"] = new JsonObject { ["pinned"] = true },
            },
            new JsonObject
            {
                ["action"] = "archive",
                ["id"] = "root",
                ["body"] = new JsonObject { ["archived"] = true, ["includeDescendants"] = true },
            },
            new JsonObject
            {
                ["action"] = "archive",
                ["id"] = "root",
                ["body"] = new JsonObject { ["archived"] = false, ["includeDescendants"] = true },
            },
            new JsonObject
            {
                ["action"] = "move",
                ["id"] = "unique-a",
                ["body"] = new JsonObject { ["parentSessionId"] = "other", ["position"] = "last" },
            },
            new JsonObject
            {
                ["action"] = "move",
                ["id"] = "A",
                ["body"] = new JsonObject
                {
                    ["parentSessionId"] = "other",
                    ["afterSessionId"] = "a",
                },
            },
            new JsonObject
            {
                ["action"] = "move",
                ["id"] = "a2",
                ["body"] = new JsonObject { ["parentSessionId"] = null, ["updateOrder"] = false },
            },
            new JsonObject
            {
                ["action"] = "promote",
                ["id"] = "a",
                ["body"] = new JsonObject { ["targetParentId"] = null },
            },
            new JsonObject
            {
                ["action"] = "pin",
                ["id"] = "a",
                ["body"] = new JsonObject { ["pinned"] = false },
            },
            new JsonObject
            {
                ["action"] = "promote",
                ["id"] = "a",
                ["body"] = new JsonObject { ["targetParentId"] = "root" },
            },
            new JsonObject
            {
                ["action"] = "move",
                ["id"] = "mover",
                ["body"] = new JsonObject { ["afterSessionId"] = "alias-anchor" },
            },
            new JsonObject
            {
                ["action"] = "move",
                ["id"] = "other",
                ["body"] = new JsonObject { ["afterSessionId"] = "orphan-anchor" },
            },
            new JsonObject
            {
                ["action"] = "move",
                ["id"] = "old-orphan",
                ["body"] = new JsonObject { ["afterSessionId"] = "orphan-anchor" },
            },
            new JsonObject
            {
                ["action"] = "promote",
                ["id"] = "space-child",
                ["body"] = new JsonObject { ["targetParentId"] = "other" },
            }
        );
        var input = Path.Combine(temp.Path, "input.json");
        var output = Path.Combine(temp.Path, "output.json");
        await File.WriteAllTextAsync(
            input,
            new JsonObject
            {
                ["rows"] = new JsonArray(rows.Select(row => (JsonNode?)row.DeepClone()).ToArray()),
                ["operations"] = operations.DeepClone(),
            }.ToJsonString()
        );
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        foreach (
            var arg in new[]
            {
                Path.Combine(repository, "dotnet", "Foxwarm.Tests", "Fixtures", "session-presentation-fixture-ts.mjs"),
                input,
                output,
            }
        )
            start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30000))
        {
            process.Kill(true);
            throw new TimeoutException("Owned source presentation oracle timed out.");
        }
        Assert.True(process.ExitCode == 0, await stdout + await stderr);
        var oracle = JsonNode.Parse(await File.ReadAllTextAsync(output))!;
        Assert.Equal("en-US", oracle["locale"]!["locale"]!.GetValue<string>());
        var sorted = rows.OrderBy(
                row => row,
                Comparer<JsonObject>.Create(SessionCatalog.CompareSidebar)
            )
            .Select(row => row["id"]!.GetValue<string>())
            .ToArray();
        Assert.Equal(oracle["sorted"]!.AsArray().Select(id => id!.GetValue<string>()), sorted);
        using var catalog = new SessionCatalog(Path.Combine(temp.Path, "data"));
        catalog.Initialize();
        catalog.Upsert(rows);
        for (var index = 0; index < operations.Count; index++)
        {
            var operation = operations[index]!;
            var body = operation["body"]!.AsObject();
            var id = operation["id"]!.GetValue<string>();
            PresentationChange actual;
            try
            {
                actual = operation["action"]!.GetValue<string>() switch
                {
                    "pin" => catalog.Pin(id, body["pinned"]!.GetValue<bool>()),
                    "archive" => catalog.Archive(
                        id,
                        body["archived"]!.GetValue<bool>(),
                        body["includeDescendants"]!.GetValue<bool>()
                    ),
                    _ => catalog.Move(
                        id,
                        body,
                        operation["action"]!.GetValue<string>() == "promote"
                    ),
                };
            }
            catch (SessionPresentationException error)
            {
                Assert.Equal(oracle["outcomes"]![index]!["status"]!.GetValue<int>(), error.Status);
                Assert.Equal(
                    oracle["outcomes"]![index]!["value"]!["code"]!.GetValue<string>(),
                    error.Code
                );
                continue;
            }
            Assert.Equal(200, oracle["outcomes"]![index]!["status"]!.GetValue<int>());
            Assert.True(
                JsonNode.DeepEquals(actual.Result, oracle["outcomes"]![index]!["value"]),
                $"Source route result {index}: {actual.Result} != {oracle["outcomes"]![index]!["value"]}"
            );
            foreach (
                var expected in oracle["outcomes"]![index]!["rows"]!.AsArray().OfType<JsonObject>()
            )
            foreach (var key in new[] { "parentSessionId", "archived", "pinned", "sidebarOrder" })
                Assert.True(
                    JsonNode.DeepEquals(
                        expected[key],
                        catalog.Get(expected["id"]!.GetValue<string>())![key]
                    ),
                    $"Source row {index}/{expected["id"]}/{key}"
                );
        }
    }

    [Theory]
    [InlineData("/session\u00A0archive root", true)]
    [InlineData("/session\uFEFFparent root", true)]
    [InlineData("/session\u0085archive root", false)]
    [InlineData("/session clear", false)]
    [InlineData("/session archive-more", false)]
    public void Only_source_presentation_command_intent_bypasses_semantic_admission(
        string command,
        bool expected
    ) => Assert.Equal(expected, MessageRouter.IsPresentationCommand(command));

    [Fact]
    public void Raw_cycle_traversal_exact_aliases_and_ambiguous_parents_are_not_the_presentation_forest()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([
            SessionCatalogTests.Row("A", 0),
            SessionCatalogTests.Row("B", 0, aliases: ["A", "shared"]),
            SessionCatalogTests.Row("C", 0, aliases: ["shared"]),
            SessionCatalogTests.Row("child", 0, "A"),
            SessionCatalogTests.Row("ambiguous", 0, "shared"),
            SessionCatalogTests.Row("self", 0, "self"),
            SessionCatalogTests.Row("x", 0, "y"),
            SessionCatalogTests.Row("y", 0, "x"),
        ]);
        var change = catalog.Archive("A", true, true);
        Assert.Equal(new[] { "A", "child" }, change.ChangedIds);
        Assert.Null(catalog.Get("B")!["archived"]);
        Assert.Null(catalog.Get("ambiguous")!["archived"]);
        foreach (var id in new[] { "self", "x" })
        {
            var revision = catalog.Revision;
            var error = Assert.Throws<SessionPresentationException>(() =>
                catalog.Archive(id, true, true)
            );
            Assert.Equal("SESSION_RELATION_CYCLE", error.Code);
            Assert.Equal(revision, catalog.Revision);
            Assert.Null(catalog.Get(id)!["archived"]);
            catalog.Pin(id, true);
            catalog.Archive(id, true);
            Assert.True(catalog.Get(id)!["pinned"]!.GetValue<bool>());
        }
        var parentError = Assert.Throws<SessionPresentationException>(() =>
            catalog.SetParent("A", "child")
        );
        Assert.Equal("PARENT_CYCLE_NOT_ALLOWED", parentError.Code);
        Assert.Equal("shared", catalog.Get("ambiguous")!["parentSessionId"]!.GetValue<string>());
    }

    [Fact]
    public void Real_writer_failure_and_postcommit_notification_failure_have_different_truthful_outcomes()
    {
        using var temp = new TempDirectory();
        using var catalog = new SessionCatalog(temp.Path);
        catalog.Initialize();
        catalog.Upsert([
            SessionCatalogTests.Row("root", 0),
            SessionCatalogTests.Row("a", 1, "root"),
            SessionCatalogTests.Row("b", 2, "root"),
        ]);
        var original = new JsonArray(
            catalog.List().Select(row => (JsonNode?)row.DeepClone()).ToArray()
        );
        var revision = catalog.Revision;
        using (var blocker = new SqliteConnection($"Data Source={catalog.FilePath};Pooling=False"))
        {
            blocker.Open();
            using var command = blocker.CreateCommand();
            command.CommandText = "BEGIN IMMEDIATE";
            command.ExecuteNonQuery();
            Assert.Throws<SqliteException>(() =>
                catalog.Move("a", new JsonObject { ["parentSessionId"] = null })
            );
            Assert.Throws<SqliteException>(() => catalog.Archive("root", true, true));
            Assert.Equal(revision, catalog.Revision);
            Assert.True(
                JsonNode.DeepEquals(
                    original,
                    new JsonArray(
                        catalog.List().Select(row => (JsonNode?)row.DeepClone()).ToArray()
                    )
                )
            );
            command.CommandText = "ROLLBACK";
            command.ExecuteNonQuery();
        }
        catalog.Move("a", new JsonObject { ["parentSessionId"] = null });
        Assert.Null(catalog.Get("a")!["parentSessionId"]);
        Assert.Equal(1000, catalog.Get("b")!["sidebarOrder"]!.GetValue<int>());
        catalog.Changed += () => throw new IOException("notification failed");
        var error = Assert.Throws<PresentationCommittedException>(() => catalog.Pin("a", true));
        Assert.True(error.Change.Result["pinned"]!.GetValue<bool>());
        Assert.True(catalog.Get("a")!["pinned"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Main_commands_mutate_cold_members_without_history_provider_or_semantic_lookup_and_emit_temporary_reply()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        using (var catalog = new SessionCatalog(data))
        {
            catalog.Initialize();
            catalog.Upsert([SessionCatalogTests.Row("one", 0), SessionCatalogTests.Row("two", 0)]);
        }
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            data,
            work,
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var reads = 0;
        manager.AdmissionReadObserved = _ => reads++;
        var runtime = new SessionRuntime(manager);
        var events = new List<SessionRuntimeEvent>();
        runtime.Changed += events.Add;
        var router = new MessageRouter(runtime);
        foreach (
            var text in new[]
            {
                "/session archive two",
                "/session parent two",
                "/session unparent",
                "/session unarchive two",
                "/session archive missing",
            }
        )
            Assert.Equal(
                200,
                (await router.HandleMessageAsync(new("one", "webui"), new(text, null))).Status
            );
        Assert.Equal(0, reads);
        Assert.Empty(manager.Owners());
        Assert.False(File.Exists(Path.Combine(data, "state", "sessions", "one.json")));
        Assert.Equal(5, events.Count);
        Assert.All(
            events,
            value =>
            {
                Assert.Equal(SessionEventKind.CommandReply, value.Kind);
                Assert.True(value.Data!["__meta"]!["temporary"]!.GetValue<bool>());
                Assert.True(value.Data["__meta"]!["isCommandResponse"]!.GetValue<bool>());
            }
        );
        Assert.Null(manager.Catalog.Get("one")!["parentSessionId"]);
        Assert.False(manager.Catalog.Get("two")!["archived"]!.GetValue<bool>());
    }
}
