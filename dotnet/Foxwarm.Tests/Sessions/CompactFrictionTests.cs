using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CompactFrictionTests
{
    [Fact]
    public void Optional_scores_preserve_valid_boundaries_and_do_not_reject_otherwise_valid_plans()
    {
        var candidate = new CompactCandidate(
            "message",
            0,
            1,
            1,
            1,
            1,
            0,
            0,
            1000,
            1000,
            "raw",
            10,
            0
        );
        var candidates = new CompactCandidates([], 1, [candidate], [], 10, 10, null, []);
        foreach (
            var (raw, expected) in new (JsonNode?, int?)[]
            {
                (null, null),
                (JsonValue.Create(0), 0),
                (JsonValue.Create(100), 100),
                (JsonValue.Create(-1), null),
                (JsonValue.Create(101), null),
                (JsonValue.Create(1.5), null),
                (JsonValue.Create("73"), null),
            }
        )
        {
            var operation = new JsonObject
            {
                ["level"] = 1,
                ["sourceKind"] = "message",
                ["sourceStart"] = 1,
                ["sourceEnd"] = 1,
                ["summary"] = "Retained requirement",
            };
            if (raw is not null)
                operation["frictionScore"] = raw;
            var plan = CompactPlanValidator.Validate(
                new JsonObject { ["replaceAsBlocks"] = new JsonArray(operation) },
                candidates
            );
            Assert.Equal(expected, Assert.Single(plan.Operations).FrictionScore);
        }
    }
}
