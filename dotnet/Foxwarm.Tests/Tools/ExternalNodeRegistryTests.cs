using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ExternalNodeRegistryTests
{
    private static JsonObject Offer(int min, int max) =>
        new()
        {
            ["nodeProtocol"] = new JsonObject { ["min"] = min, ["max"] = max },
        };

    private static JsonObject Pair(string name = "candidate") =>
        new()
        {
            ["requestedName"] = name,
            ["nodeType"] = "cli-node",
            ["capabilities"] = new JsonObject { ["tools"] = new JsonArray() },
        };

    [Fact]
    public void Direct_credentials_and_offline_pairing_claim_survive_restart_without_listing_secrets()
    {
        using var temp = new TempDirectory();
        var registry = new ApprovedNodeRegistry(temp.Path);
        var direct = registry.Create("direct");
        Assert.True(registry.Authenticate("direct", direct["authToken"]!.GetValue<string>()));
        Assert.False(registry.Authenticate("direct", "wrong"));
        var request = registry.Request(Pair(), NodeConnectionHub.Protocol(Offer(1, 3)));
        var credentials = registry.Approve(request["id"]!.GetValue<string>(), null);
        var summary =
            registry.ListApproved().ToJsonString() + registry.ListPending().ToJsonString();
        Assert.DoesNotContain("authToken", summary);
        Assert.DoesNotContain("tokenHash", summary);
        Assert.DoesNotContain(credentials["authToken"]!.GetValue<string>(), summary);
        var restarted = new ApprovedNodeRegistry(temp.Path);
        Assert.Equal(registry.PairingToken, restarted.PairingToken);
        Assert.True(restarted.Authenticate("direct", direct["authToken"]!.GetValue<string>()));
        var claimed = restarted.Claim("cli-node", "candidate")!;
        Assert.True(JsonNode.DeepEquals(credentials, claimed));
        Assert.Null(restarted.Claim("cli-node", "candidate"));
        restarted.Cleanup(ApprovedNodeRegistry.Now + ApprovedNodeRegistry.PairingTtl + 1);
        Assert.True(
            restarted.Authenticate("candidate", credentials["authToken"]!.GetValue<string>())
        );
    }

    [Fact]
    public void Expiry_removes_unclaimed_identity_but_not_successfully_claimed_credentials_and_rename_invalidates_old_id()
    {
        using var temp = new TempDirectory();
        var registry = new ApprovedNodeRegistry(temp.Path);
        var request = registry.Request(Pair(), NodeConnectionHub.Protocol(new()));
        var credential = registry.Approve(request["id"]!.GetValue<string>(), "unclaimed");
        registry.Cleanup(ApprovedNodeRegistry.Now + ApprovedNodeRegistry.PairingTtl + 10);
        Assert.False(
            registry.Authenticate("unclaimed", credential["authToken"]!.GetValue<string>())
        );
        Assert.Empty(registry.ListPending());
        var direct = registry.Create("before");
        registry.Rename("before", "after");
        Assert.False(registry.Authenticate("before", direct["authToken"]!.GetValue<string>()));
        Assert.True(
            new ApprovedNodeRegistry(temp.Path).Authenticate(
                "after",
                direct["authToken"]!.GetValue<string>()
            )
        );
        registry.Remove("after");
        Assert.False(
            new ApprovedNodeRegistry(temp.Path).Authenticate(
                "after",
                direct["authToken"]!.GetValue<string>()
            )
        );
    }

    [Fact]
    public void Source_numbered_backup_and_legacy_pending_code_preserve_the_real_unclaimed_handoff()
    {
        using var temp = new TempDirectory();
        var registry = new ApprovedNodeRegistry(temp.Path);
        var request = registry.Request(Pair(), NodeConnectionHub.Protocol(new()));
        var credential = registry.Approve(request["id"]!.GetValue<string>(), "candidate");
        var file = Path.Combine(temp.Path, "state", "nodes.json");
        var raw = JsonNode.Parse(File.ReadAllText(file))!.AsObject();
        raw["pendingPairings"]![request["id"]!.GetValue<string>()]!["pairCode"] = "123456";
        File.WriteAllText(file + ".1.bak", raw.ToJsonString());
        File.WriteAllText(file, "not JSON");
        var restored = new ApprovedNodeRegistry(temp.Path);
        Assert.DoesNotContain("pairCode", restored.ListPending().ToJsonString());
        Assert.Equal(
            credential["authToken"]!.GetValue<string>(),
            restored.Claim("cli-node", "candidate")!["authToken"]!.GetValue<string>()
        );
    }

    [Theory]
    [InlineData(1, 1, 1)]
    [InlineData(1, 2, 2)]
    [InlineData(1, 3, 3)]
    [InlineData(2, 9, 3)]
    public void Protocol_negotiates_actual_intersection(int min, int max, int selected)
    {
        var protocol = NodeConnectionHub.Protocol(Offer(min, max));
        Assert.Equal(selected, protocol["negotiated"]!.GetValue<int>());
        Assert.Equal("compatible", protocol["status"]!.GetValue<string>());
        Assert.False(protocol["legacyClient"]!.GetValue<bool>());
        var legacy = NodeConnectionHub.Protocol(new());
        Assert.True(legacy["legacyClient"]!.GetValue<bool>());
        Assert.Equal(1, legacy["negotiated"]!.GetValue<int>());
    }

    [Fact]
    public void Disjoint_offer_is_quarantined_and_malformed_offers_are_rejected()
    {
        var disjoint = NodeConnectionHub.Protocol(Offer(4, 9));
        Assert.Equal("upgrade-required", disjoint["status"]!.GetValue<string>());
        Assert.Null(disjoint["negotiated"]);
        foreach (
            var raw in new[]
            {
                "null",
                "[]",
                "{\"min\":0,\"max\":3}",
                "{\"min\":2,\"max\":1}",
                "{\"min\":1.5,\"max\":3}",
                "{\"min\":1,\"max\":1000001}",
                "{\"min\":1,\"max\":3,\"future\":true}",
            }
        )
            Assert.Throws<InvalidDataException>(() =>
                NodeConnectionHub.Protocol(
                    new JsonObject { ["nodeProtocol"] = JsonNode.Parse(raw) }
                )
            );
    }

    [Fact]
    public void Remote_result_keeps_JSON_values_and_normalizes_only_documented_Node_carriers()
    {
        foreach (
            var raw in new[]
            {
                "null",
                "false",
                "0",
                "\"hello\"",
                "[1,null,false]",
                "{\"result\":{\"sentNotifications\":99},\"cwd\":\"peer-path\"}",
            }
        )
        {
            var value = JsonNode.Parse(raw);
            Assert.True(JsonNode.DeepEquals(value, RemoteNodeResult.Normalize(value)));
        }
        var image = RemoteNodeResult.Normalize(
            JsonNode.Parse(
                "{\"output\":\"__SCREENSHOT__:aGVsbG8=\",\"annotation\":false,\"__foxwarmResolvedToolPaths\":[{\"resolved\":\"peer\"}]}"
            )
        )!;
        Assert.Null(image["output"]);
        Assert.Null(image["__foxwarmResolvedToolPaths"]);
        Assert.Equal("image/png", image["inlineData"]!["mimeType"]!.GetValue<string>());
        Assert.False(image["annotation"]!.GetValue<bool>());
    }
}
