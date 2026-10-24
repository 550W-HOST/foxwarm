using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Tests;

public sealed class SessionCatalogSourceTests
{
    [Fact]
    public async Task Actual_source_schema_v1_upgrade_projections_queries_and_full_unicode_search_match()
    {
        using var temp = new TempDirectory();
        var repository =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException(
                "FOXWARM_TS_ROOT is required for the actual source oracle."
            );
        var rows = new List<JsonObject>
        {
            SessionCatalogTests.Row("root", 50, aliases: ["root-alias"]),
            SessionCatalogTests.Row("ordered", 10),
            SessionCatalogTests.Row("dangling", 5, "missing"),
            SessionCatalogTests.Row("self", 7, "self"),
            SessionCatalogTests.Row("cycle-a", 8, "cycle-b"),
            SessionCatalogTests.Row("cycle-b", 9, "cycle-a"),
            SessionCatalogTests.Row("alpha/a", 30, "shared", "alpha", ["shared"]),
            SessionCatalogTests.Row("alpha/b", 20, "root-alias", "alpha", ["shared"]),
            SessionCatalogTests.Row("beta/c", 15, "root", "beta"),
        };
        rows[0]["sidebarOrder"] = 2;
        rows[1]["sidebarOrder"] = 1;
        rows[7]["busy"] = true;
        rows[7]["stats"] = new JsonObject
        {
            ["totalCachedTokens"] = 1,
            ["totalInputTokens"] = 2,
            ["totalOutputTokens"] = 3,
            ["lastUsage"] = null,
        };
        for (var index = 0; index < 14; index++)
        {
            var row = SessionCatalogTests.Row("child-" + index, index + 30, "root");
            row["pinned"] = index == 13;
            row["archived"] = index == 12;
            if (index % 3 == 0)
                row["sidebarOrder"] = index;
            rows.Add(row);
        }
        rows.Add(SessionCatalogTests.Row("ΟΣ", 50, "root"));
        rows.Add(SessionCatalogTests.Row("İ", 25));
        rows.Add(SessionCatalogTests.Row("𐐀", 26));
        rows.Add(SessionCatalogTests.Row("😀", 27));
        var input = Path.Combine(temp.Path, "input.json");
        var output = Path.Combine(temp.Path, "result.json");
        await File.WriteAllTextAsync(
            input,
            new JsonArray(rows.Select(row => (JsonNode?)row.DeepClone()).ToArray()).ToJsonString()
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
                Path.Combine(repository, "dotnet", "Foxwarm.Tests", "Fixtures", "session-catalog-fixture-ts.mjs"),
                temp.Path,
                input,
                output,
            }
        )
            start.ArgumentList.Add(arg);
        start.Environment["FOXWARM_TS_ROOT"] = repository;
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30000))
        {
            process.Kill(entireProcessTree: true);
            throw new TimeoutException("Owned source catalog oracle timed out.");
        }
        var log = await stdout + await stderr;
        Assert.True(process.ExitCode == 0, log);
        var expected = JsonNode.Parse(await File.ReadAllTextAsync(output))!.AsObject();
        var root = Path.Combine(temp.Path, "current");
        using var catalog = new SessionCatalog(root);
        catalog.Initialize();
        catalog.Upsert(rows);
        Equal(expected["expected"], Snapshot(catalog, rows), "current source queries");
        Equal(
            expected["schema"],
            SourceCoreSchema(catalog.FilePath),
            "current source core plus one approved wait index"
        );
        var oldRoot = Path.Combine(temp.Path, "old");
        Directory.CreateDirectory(Path.Combine(oldRoot, "state"));
        File.Copy(
            Path.Combine(temp.Path, "dotnet-v1.sqlite"),
            Path.Combine(oldRoot, "state", "catalog.sqlite")
        );
        using var old = new SessionCatalog(oldRoot);
        old.Initialize();
        Equal(expected["upgraded"], Snapshot(old, rows), "source v1 upgrade queries");
        Equal(
            expected["upgradedSchema"],
            SourceCoreSchema(old.FilePath),
            "source v1 upgrade core plus one approved wait index"
        );
        old.Dispose();
        using var again = new SessionCatalog(oldRoot);
        again.Initialize();
        Equal(expected["upgraded"], Snapshot(again, rows), "reopened upgraded source schema");
        Assert.Equal(
            await File.ReadAllTextAsync(Path.Combine(temp.Path, "lower-expected.txt")),
            SourceStringLower.Lower(
                await File.ReadAllTextAsync(Path.Combine(temp.Path, "lower-input.txt"))
            )
        );
    }

    private static void Equal(JsonNode? expected, JsonNode? actual, string label)
    {
        Assert.True(
            JsonNode.DeepEquals(expected, actual),
            label
                + "\nExpected: "
                + expected?.ToJsonString()
                + "\nActual: "
                + actual?.ToJsonString()
        );
    }

    private static string Id(JsonObject row) => row["id"]!.GetValue<string>();

    private static JsonArray Rows(IEnumerable<JsonObject> rows) =>
        new(rows.Select(row => (JsonNode?)row.DeepClone()).ToArray());

    private static JsonArray Key(JsonObject row, string mode, bool child = false)
    {
        var key = new JsonArray();
        if (!child)
            key.Add(SessionCatalog.Flag(row["pinned"]) ? 0 : 1);
        key.Add(SessionCatalog.Flag(row["archived"]) ? 1 : 0);
        if (mode == "default")
        {
            key.Add(SessionCatalog.Number(row["sidebarOrder"]) is null ? 1 : 0);
            key.Add(SessionCatalog.Number(row["sidebarOrder"]) ?? 0);
        }
        key.Add(-(SessionCatalog.Number(row["meta"]?["lastMessageTime"]) ?? 0));
        key.Add(Id(row));
        return key;
    }

    private static JsonObject Page(CatalogPage page) =>
        new() { ["rows"] = Rows(page.Rows), ["hasMore"] = page.HasMore };

    private static JsonArray Children(CatalogChildren[] groups) =>
        new(
            groups
                .Select(group =>
                    (JsonNode?)
                        new JsonObject
                        {
                            ["parent"] = group.Parent,
                            ["rows"] = Rows(group.Rows),
                            ["total"] = group.Total,
                            ["hasMore"] = group.HasMore,
                        }
                )
                .ToArray()
        );

    private static JsonObject Snapshot(SessionCatalog catalog, List<JsonObject> supplied)
    {
        var ids = supplied.Select(Id).ToArray();
        string[] parents = ["root", "alpha/a", "cycle-a", "none"];
        var pages = new JsonArray();
        var children = new JsonArray();
        foreach (var mode in new[] { "default", "time", "flat-time" })
        foreach (var roots in new[] { true, false })
        {
            var first = catalog.Page(mode, 3, null, roots && mode != "flat-time", null);
            var second = catalog.Page(
                mode,
                3,
                first.HasMore ? Key(first.Rows[^1], mode) : null,
                roots && mode != "flat-time",
                null
            );
            pages.Add(
                new JsonObject
                {
                    ["mode"] = mode,
                    ["roots"] = roots,
                    ["first"] = Page(first),
                    ["second"] = Page(second),
                }
            );
        }
        foreach (var mode in new[] { "default", "time" })
        {
            var first = catalog.Children(
                parents.Select(parent => (parent, (JsonArray?)null)).ToArray(),
                mode,
                2,
                null
            );
            var second = catalog.Children(
                first
                    .Select(group =>
                        (group.Parent, group.HasMore ? Key(group.Rows[^1], mode, true) : null)
                    )
                    .ToArray(),
                mode,
                2,
                null
            );
            children.Add(
                new JsonObject
                {
                    ["mode"] = mode,
                    ["first"] = Children(first),
                    ["second"] = Children(second),
                }
            );
        }
        var resolutions = new JsonObject();
        foreach (var pair in catalog.ResolveMany([.. ids, "shared", "root-alias", "not-found"]))
            resolutions[pair.Key] = pair.Value;
        var scopes = new JsonObject();
        foreach (var pair in catalog.Scopes(ids))
            scopes[pair.Key] = pair.Value;
        var paths = new JsonObject();
        foreach (var pair in catalog.Paths(ids))
            paths[pair.Key] = new JsonArray(
                pair.Value.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray()
            );
        JsonObject Counts<T>(Dictionary<string, T> source)
        {
            var result = new JsonObject();
            foreach (var pair in source)
                result[pair.Key] = System.Text.Json.JsonSerializer.SerializeToNode(pair.Value);
            return result;
        }
        var descendant = catalog.Descendants("root", 5);
        var summary = descendant.Summary;
        summary["rows"] = Rows(descendant.Rows);
        return new JsonObject
        {
            ["records"] = Rows(catalog.GetMany(ids)),
            ["resolutions"] = resolutions,
            ["scopes"] = scopes,
            ["paths"] = paths,
            ["summary"] = catalog.Summary(),
            ["agents"] = catalog.AgentCounts(),
            ["counts"] = Counts(catalog.ChildCounts(parents)),
            ["agentCounts"] = Counts(catalog.ChildCounts(parents, "beta")),
            ["busy"] = Counts(
                catalog.BusyDescendants(
                    parents,
                    supplied.Where(row => SessionCatalog.Flag(row["busy"])).Select(Id).ToArray()
                )
            ),
            ["descendants"] = summary,
            ["pages"] = pages,
            ["children"] = children,
            ["forest"] = Page(catalog.Page("time", 3, null, true, "beta")),
        };
    }

    private static JsonArray SourceCoreSchema(string file)
    {
        var all = Schema(file);
        var index = Assert.Single(
            all.OfType<JsonObject>(),
            row => row["name"]?.GetValue<string>() == "idx_session_catalog_wait_presence"
        );
        Assert.Equal("index", index["type"]!.GetValue<string>());
        Assert.Equal(
            "createindexidx_session_catalog_wait_presenceonsession_catalog(session_id)wherejson_type(metadata_json,'$.meta.wait.id')='text'",
            index["sql"]!.GetValue<string>()
        );
        all.Remove(index);
        return all;
    }

    private static JsonArray Schema(string file)
    {
        using var db = new SqliteConnection($"Data Source={file};Mode=ReadOnly");
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText =
            "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
        using var reader = command.ExecuteReader();
        var result = new JsonArray();
        while (reader.Read())
            result.Add(
                new JsonObject
                {
                    ["type"] = reader.GetString(0),
                    ["name"] = reader.GetString(1),
                    ["sql"] = Regex.Replace(reader.GetString(2), "\\s+", "").ToLowerInvariant(),
                }
            );
        return result;
    }
}
