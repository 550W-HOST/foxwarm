using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class IdleCompactConfigurationTests
{
    [Fact]
    public void Idle_settings_resolve_model_then_provider_then_models_defaults_with_zero_disable()
    {
        var root = JsonNode.Parse("""
            {"providers":{
              "global":{"models":["wire"]},
              "provider":{"idleCompactMinutes":40,"idleCompactMinContextPercent":0.6,
                "models":["inherited",{"id":"override","idleCompactMinutes":20,"idleCompactMinContextPercent":0.7},
                  {"id":"off","idleCompactMinutes":0}]}
            }}
            """)!.AsObject();
        var defaults = HostModels.Parse(root, new JsonObject()).Resolve("global").Configuration;
        Assert.Equal(0, defaults["idleCompactMinutes"]!.GetValue<int>());
        Assert.Equal(.5, defaults["idleCompactMinContextPercent"]!.GetValue<double>());
        root["defaults"] = new JsonObject
        {
            ["idleCompactMinutes"] = 55,
            ["idleCompactMinContextPercent"] = 0.5,
        };
        var catalog = HostModels.Parse(root, new JsonObject());
        Check("global", 55, .5);
        Check("provider/inherited", 40, .6);
        Check("provider/override", 20, .7);
        Check("provider/off", 0, .6);
        void Check(string key, double minutes, double fraction)
        {
            var resolved = catalog.Resolve(key).Configuration;
            Assert.Equal(minutes, SessionNumber(resolved["idleCompactMinutes"]));
            Assert.Equal(fraction, SessionNumber(resolved["idleCompactMinContextPercent"]));
        }
    }

    [Theory]
    [InlineData("idleCompactMinutes", "-1")]
    [InlineData("idleCompactMinutes", "null")]
    [InlineData("idleCompactMinutes", "true")]
    [InlineData("idleCompactMinutes", "\"55\"")]
    [InlineData("idleCompactMinContextPercent", "0")]
    [InlineData("idleCompactMinContextPercent", "1.01")]
    [InlineData("idleCompactMinContextPercent", "null")]
    [InlineData("idleCompactMinContextPercent", "false")]
    public void Invalid_idle_settings_are_rejected_in_each_configuration_scope(string field, string raw)
    {
        var invalid = JsonNode.Parse("{\"" + field + "\":" + raw + "}")!.AsObject();
        foreach (var scope in new[] { "defaults", "provider", "model" })
        {
            var provider = new JsonObject();
            JsonObject? defaults = null;
            if (scope == "defaults")
                defaults = (JsonObject)invalid.DeepClone();
            else if (scope == "provider")
                provider = (JsonObject)invalid.DeepClone();
            else
            {
                var model = (JsonObject)invalid.DeepClone();
                model["id"] = "wire";
                provider["models"] = new JsonArray(model);
            }
            var root = new JsonObject { ["providers"] = new JsonObject { ["p"] = provider } };
            if (defaults is not null)
                root["defaults"] = defaults;
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, new JsonObject()));
        }
    }

    [Theory]
    [InlineData("idleCompactMinutes")]
    [InlineData("idleCompactMinContextPercent")]
    public void Nonfinite_numbers_and_virtual_overrides_are_rejected(string field)
    {
        Assert.Throws<InvalidDataException>(() =>
            HostModels.ValidateIdleCompact(new JsonObject { [field] = double.PositiveInfinity })
        );
        Assert.Throws<InvalidDataException>(() =>
            HostModels.ValidateIdleCompact(new JsonObject { [field] = double.NaN })
        );
        var root = JsonNode.Parse(
            """{"providers":{"leaf":{},"route":{"providerType":"session-hash","targets":["leaf"]}}}"""
        )!.AsObject();
        root["providers"]!["route"]![field] = .5;
        Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, new JsonObject()));
    }

    [Fact]
    public void Idle_model_resolution_uses_the_current_hash_or_failover_leaf_and_its_settings()
    {
        var root = JsonNode.Parse("""
            {"providers":{
              "a":{"idleCompactMinutes":55,"contextLimit":20000},
              "b":{"idleCompactMinutes":0,"contextLimit":40000},
              "hash":{"providerType":"session-hash","targets":["a","b"]},
              "failover":{"providerType":"failover","targets":["a","b"],"failureThreshold":1}
            }}
            """)!.AsObject();
        var catalog = HostModels.Parse(root, new JsonObject());
        var routing = new ModelRouting(() => 0);
        using var http = new HttpClient();
        var requests = TestModelOwners.Create(
            http,
            new(new Uri("http://localhost"), "wire", "a", "", "", 1000),
            routing
        );
        var state = new SessionState("s");
        state.AuthorityEnvelope["promptCacheKey"] = "cache";
        state.AuthorityEnvelope["model"] = "hash";
        var hashed = ModelRouting.Hash("hash", "cache", ["a", "b"]).TargetKey;
        Assert.Equal(hashed, requests.ResolveConcrete(catalog, state.Snapshot()).Key);
        state.AuthorityEnvelope["model"] = "failover";
        Assert.Equal("a", requests.ResolveConcrete(catalog, state.Snapshot()).Key);
        var request = routing.Begin("failover", catalog.Resolve("failover"));
        var changed = (JsonObject)root.DeepClone();
        changed["providers"]!["b"]!["contextLimit"] = 80000;
        var changedCatalog = HostModels.Parse(changed, new JsonObject());
        // An idle eligibility read of a changed catalog must not activate a new health generation.
        Assert.Equal("a", requests.ResolveConcrete(changedCatalog, state.Snapshot()).Key);
        routing.Failed(request, routing.Select(request, "cache"));
        var selected = requests.ResolveConcrete(catalog, state.Snapshot());
        Assert.Equal("b", selected.Key);
        Assert.Equal(40000, selected.ContextLimit);
        Assert.Equal(0, SessionNumber(selected.Configuration["idleCompactMinutes"]));
    }

    [Fact]
    public void Idle_resolution_keeps_the_normal_failover_redaction_eligibility()
    {
        var catalog = HostModels.Parse(JsonNode.Parse("""
            {"providers":{
              "a":{"textRedaction":{"enabled":true,"endpoint":"http://localhost/classify"}},
              "b":{},
              "route":{"providerType":"failover","targets":["a","b"],"failureThreshold":1}
            }}
            """)!.AsObject(), new JsonObject());
        var routing = new ModelRouting(() => 0);
        var request = routing.Begin("route", catalog.Resolve("route"));
        routing.Failed(request, routing.Select(request, "cache"));
        using var http = new HttpClient();
        var requests = TestModelOwners.Create(
            http,
            new(new Uri("http://localhost"), "wire", "a", "", "", 1000),
            routing
        );
        var state = new SessionState("s");
        state.AuthorityEnvelope["model"] = "route";
        state.AuthorityEnvelope["promptCacheKey"] = "cache";
        Assert.Equal("a", requests.ResolveConcrete(catalog, state.Snapshot()).Key);
    }

    private static double SessionNumber(JsonNode? value) => SessionWait.Number(value)!.Value;
}
