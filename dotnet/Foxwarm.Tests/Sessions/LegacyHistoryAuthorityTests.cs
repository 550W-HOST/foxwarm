using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class LegacyHistoryAuthorityTests
{

    private static string Authority(string root, string id = "legacy") =>
        Path.Combine(root, "state", "sessions", id + ".json");

    private static void EqualHistory(JsonArray expected, IEnumerable<HistoryMessage> actual) =>
        Assert.True(
            JsonNode.DeepEquals(
                expected,
                new JsonArray(actual.Select(row => (JsonNode)row.ToJson()).ToArray())
            )
        );

    private static Task Complete(
        System.Net.Sockets.NetworkStream stream,
        params JsonObject[] output
    ) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = "legacy-history-reply",
                            ["output"] = new JsonArray(output.Cast<JsonNode>().ToArray()),
                        },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Null_parent_uses_catalog_topology_and_survives_first_catalog_migration(
        bool hasParent
    )
    {
        using var temp = new TempDirectory();
        await SessionCatalogMigrationTests.Authority(temp.Path, "legacy");
        var file = Authority(temp.Path);
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(file))!.AsObject();
        raw["parentSessionId"] = null;
        raw["history"] = new JsonArray(
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "Legacy no metadata" }),
            }
        );
        raw["meta"]!["messageCount"] = 1;
        await File.WriteAllTextAsync(file, raw.ToJsonString());
        var row = SessionCatalogTests.Row("legacy", 0);
        row["parentSessionId"] = hasParent ? "parent" : null;
        var rows = new JsonObject { ["legacy"] = row };
        if (hasParent)
        {
            await SessionCatalogMigrationTests.Authority(temp.Path, "parent");
            rows["parent"] = SessionCatalogTests.Row("parent", 0);
        }
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state/sessions.json"),
            new JsonObject { ["sessions"] = rows }.ToJsonString()
        );
        var original = await File.ReadAllTextAsync(file);
        var report = SessionUpgradeInspection.Inspect(HostPaths.ForDataRoot(temp.Path));
        Assert.Empty(report.Issues);
        Assert.Equal(original, await File.ReadAllTextAsync(file));
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.RequiredAsync("legacy");
        Assert.Equal(
            hasParent ? "parent" : null,
            SessionWait.Text(owner.Entry.Snapshot().AuthorityEnvelope["parentSessionId"])
        );
        await owner.Entry.SaveLane.SaveStrictAsync();
        var saved = JsonNode.Parse(await File.ReadAllTextAsync(file))!;
        Assert.True(JsonNode.DeepEquals(raw["history"], saved["history"]));
        Assert.Equal(hasParent, saved.AsObject().ContainsKey("parentSessionId"));
    }

    [Fact]
    public void Active_optional_metadata_does_not_relax_new_Archive_admission_or_present_invalid_fields()
    {
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "Legacy" }),
        };
        foreach (
            var metadata in new JsonNode?[]
            {
                null,
                new JsonObject(),
                new JsonObject { ["timestamp"] = 0 },
                new JsonObject { ["seq"] = 3 },
                new JsonObject { ["seq"] = null, ["timestamp"] = null },
            }
        )
        {
            message["__meta"] = metadata?.DeepClone();
            SessionAuthorityDocument.ValidateMessage(message, null, "history[0]");
            Assert.Throws<InvalidDataException>(() =>
                ArchiveMessageRecord.Create("legacy", "main", 3, 0, message)
            );
        }
        foreach (
            var invalid in new JsonObject[]
            {
                new() { ["seq"] = 0 },
                new() { ["seq"] = -1 },
                new() { ["seq"] = 1.5 },
                new() { ["seq"] = "3" },
                new() { ["timestamp"] = "old" },
            }
        )
        {
            message["__meta"] = invalid;
            Assert.Throws<InvalidDataException>(() =>
                SessionAuthorityDocument.ValidateMessage(message, null, "history[0]")
            );
        }
        message["__meta"] = new JsonObject { ["seq"] = 3, ["timestamp"] = 0 };
        Assert.Equal(3, ArchiveMessageRecord.Create("legacy", "main", 3, 0, message).Seq);
    }
}
