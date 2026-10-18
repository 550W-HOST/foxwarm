using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Vector;

namespace Foxwarm.Tests;

[Collection("Vector native")]
public sealed class VectorSearchQualityTests
{
    private static JsonObject Hit(
        string id,
        string kind,
        long first,
        long last,
        double distance,
        int block = 0,
        int chunk = 0
    ) =>
        new()
        {
            ["id"] = id + ":" + chunk,
            ["message_id"] = id,
            ["session_id"] = "main/quality",
            ["agent"] = "main",
            ["kind"] = kind,
            ["start_seq"] = first,
            ["end_seq"] = last,
            ["raw_start_seq"] = first,
            ["raw_end_seq"] = last,
            ["block_id"] = block,
            ["chunk_index"] = chunk,
            ["chunk_count"] = 2,
            ["text"] = id,
            ["chunk_text"] = id,
            ["_distance"] = distance,
            ["timestamp"] = last * 1000,
            ["start_timestamp"] = first * 1000,
            ["end_timestamp"] = last * 1000,
            ["fact_kind"] = "decision",
            ["attributed_to"] = "user",
        };

    [Fact]
    public async Task Source_families_distance_buckets_fact_metadata_overlap_diversity_and_hybrid_fusion_match_frozen_Source()
    {
        await using var f = await VectorFixture.CreateAsync();
        JsonObject[] rows =
        [
            Hit("first", "raw", 1, 10, .1),
            Hit("first", "raw", 1, 10, .11, chunk: 1),
            Hit("overlap", "raw", 2, 11, .1),
            Hit("other", "raw", 20, 25, .12),
            Hit("block", "block", 1, 3, .1000001, block: 1),
            Hit("fact-a", "fact", 1, 3, .1, block: 1),
            Hit("fact-b", "fact", 1, 3, .1000002, block: 1),
            Hit("fact-only", "fact", 30, 34, .1000001, block: 2),
        ];
        JsonObject[] lexical =
        [
            new()
            {
                ["id"] = "fts:4",
                ["kind"] = "raw",
                ["session_id"] = "main/quality",
                ["agent"] = "main",
                ["source_family"] = "main/quality:raw:4",
                ["raw_start_seq"] = 4,
                ["raw_end_seq"] = 4,
                ["lexical_lane"] = "identifier",
                ["lexical_rank"] = 0,
                ["lexical_score"] = 104,
                ["lexical_locators"] = new JsonArray("Identifier"),
            },
            new()
            {
                ["id"] = "fts:block:3",
                ["kind"] = "block",
                ["session_id"] = "main/quality",
                ["agent"] = "main",
                ["source_family"] = "main/quality:block:3",
                ["raw_start_seq"] = 99,
                ["raw_end_seq"] = 104,
                ["block_id"] = 3,
                ["lexical_lane"] = "prose",
                ["lexical_rank"] = 0,
                ["lexical_score"] = 2,
            },
        ];
        var cases = new JsonArray();
        var expected = new JsonArray();
        foreach (
            var (limit, prefer, withLexical) in new[]
            {
                (1, false, false),
                (1, true, false),
                (10, false, false),
                (5, true, true),
            }
        )
        {
            var groups = VectorRuntime.SelectSources(rows, limit, prefer);
            var lex = withLexical ? lexical : [];
            cases.Add(
                new JsonObject
                {
                    ["rows"] = new JsonArray(
                        rows.Select(row => (JsonNode?)row.DeepClone()).ToArray()
                    ),
                    ["limit"] = limit,
                    ["preferBlocks"] = prefer,
                    ["lexical"] = new JsonArray(
                        lex.Select(row => (JsonNode?)row.DeepClone()).ToArray()
                    ),
                }
            );
            expected.Add(
                new JsonObject
                {
                    ["selected"] = new JsonArray(
                        groups.Selected.Select(row => (JsonNode?)row.DeepClone()).ToArray()
                    ),
                    ["diverseCount"] = groups.DiverseCount,
                    ["fused"] = new JsonArray(
                        VectorRuntime
                            .Fuse(groups.Selected, lex, limit)
                            .Select(row => (JsonNode?)row.DeepClone())
                            .ToArray()
                    ),
                }
            );
        }
        var input = Path.Combine(f.Temp.Path, "quality-input.json");
        await File.WriteAllTextAsync(
            input,
            EcmaJson.Stringify(new JsonObject { ["cases"] = cases })
        );
        var source = await VectorFixture.SourceAsync(
            "quality",
            Path.Combine(f.Temp.Path, "source-quality"),
            input,
            Path.Combine(f.Temp.Path, "quality-result.json")
        );
        VectorRecipeTests.EqualJson(source, expected);
    }
}
