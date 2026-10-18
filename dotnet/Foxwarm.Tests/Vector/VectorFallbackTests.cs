using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorFallbackTests
{
    [Fact]
    public async Task Persisted_legacy_fact_without_Archive_source_has_an_admin_compatibility_preview_and_metadata_only_warning()
    {
        await using var f = await VectorFixture.CreateAsync();
        var root = Path.Combine(f.Temp.Path, "legacy");
        const string id = "main/legacy-source";
        var input = new JsonObject
        {
            ["config"] = new JsonObject
            {
                ["vector"] = new JsonObject { ["baseUrl"] = f.Peer.BaseUrl },
                ["dbWorkers"] = false,
                ["vectorMaintenance"] = false,
            },
            ["records"] = new JsonArray(),
            ["sessionId"] = id,
            ["facts"] = new JsonObject
            {
                ["sessionId"] = id,
                ["agent"] = "main",
                ["sourceStartSeq"] = 1,
                ["sourceEndSeq"] = 9,
                ["createdAt"] = 1000,
                ["facts"] = new JsonArray(
                    new JsonObject
                    {
                        ["kind"] = "decision",
                        ["text"] =
                            "violet compatibility fallback marker "
                            + string.Concat(Enumerable.Repeat("e\u0301", 510)),
                        ["attributedTo"] = "user",
                    }
                ),
            },
        };
        var inputPath = Path.Combine(f.Temp.Path, "legacy-input.json");
        await File.WriteAllTextAsync(inputPath, EcmaJson.Stringify(input));
        var source = await VectorFixture.SourceAsync(
            "storage-create",
            root,
            inputPath,
            Path.Combine(f.Temp.Path, "legacy-result.json")
        );
        Assert.Single(source["rows"]!.AsArray());
        await using var service = new VectorService(root, f.Configuration());
        await service.StartAsync();
        await service.WaitForStartupAsync();
        var warnings = new List<JsonObject>();
        SqliteArchiveMessageStore Archive(string session) =>
            new(Path.Combine(root, "state", "archive-store.sqlite"), session);
        var result = await VectorRecall.SearchAsync(
            service,
            Archive,
            "violet",
            5,
            new(),
            "global",
            null,
            bounded: true,
            fallbackWarning: warning =>
            {
                warnings.Add(warning);
                throw new IOException("logging failure must not break compatibility recall");
            }
        );
        var hit = Assert.Single(result.Sources)!.AsObject();
        Assert.Equal("unavailable", hit["kind"]!.GetValue<string>());
        Assert.Empty(hit["messages"]!.AsArray());
        Assert.Contains(
            "compatibility fallback marker",
            hit["fallbackExcerpt"]!.GetValue<string>()
        );
        Assert.Equal(
            source["fallbacks"]![0]!.GetValue<string>(),
            hit["fallbackExcerpt"]!.GetValue<string>()
        );
        var logged = Assert.Single(warnings).ToJsonString();
        Assert.DoesNotContain("violet", logged);
        Assert.DoesNotContain("fallback marker", logged);
        Assert.Equal("archive-message-source-missing", warnings[0]["reason"]!.GetValue<string>());
        Assert.Empty(
            (await service.SearchAsync("violet", 5, new(LineageSessions: [new(id, 5, 0)]))).Hits
        );
    }
}
