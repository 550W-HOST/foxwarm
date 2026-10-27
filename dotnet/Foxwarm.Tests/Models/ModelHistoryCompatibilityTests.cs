using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ModelHistoryCompatibilityTests
{
    private static JsonObject Document() => JsonNode.Parse("""
        {"default":"b/m","providers":{
          "a":{"models":["m","other","vendor/family/m"]},
          "b":{"sameProviderAs":"a","models":["m","unlisted",
            {"id":"other","sameModelAs":"a/m"},
            {"id":"variant","sameModelAs":"m"},
            {"id":"qualified","sameModelAs":"a/vendor/family/m"},
            {"id":"vendor/family/variant","sameModelAs":"vendor/family/m"},"vendor/family/m"]},
          "c":{"sameProviderAs":"b","models":["m","unlisted"]},
          "d":{"models":[{"id":"m","sameModelAs":"b/variant"}]},
          "route":{"providerType":"session-hash","targets":["a/m"]}
        }}
        """)!.AsObject();

    [Fact]
    public void Whole_local_and_qualified_references_provider_mapping_and_overrides_resolve_chains()
    {
        var catalog = HostModels.Parse(Document(), new JsonObject());
        var matches = catalog.Resolve("b/m").HistoryCompatibility;
        foreach (var key in new[] { "b/m", "b/other", "b/variant", "c/m", "d/m" })
        {
            Assert.True(matches.Matches("a/m", key), key);
            Assert.True(matches.Matches(key, "a/m"), key);
        }
        Assert.False(matches.Matches("a/other", "b/other"));
        Assert.True(matches.Matches("b/qualified", "a/vendor/family/m"));
        Assert.True(matches.Matches("b/vendor/family/variant", "a/vendor/family/m"));
        // Provider equivalence covers different configured model sets and inferred chain steps.
        Assert.True(matches.Matches("c/unlisted", "b/unlisted"));
        Assert.True(matches.Matches("b/unlisted", "a/unlisted"));
        Assert.False(matches.Matches("deleted/m", "a/m"));
        Assert.False(matches.Matches("b/deleted", "a/deleted"));
        Assert.True(matches.Matches("deleted/m", "deleted/m"));
        Assert.False(matches.Matches("route", "a/m"));
        Assert.False(matches.Matches("d", "a/m")); // Selectable provider aliases are not canonical source IDs.
        Assert.Equal("b/other", catalog.Resolve("b/other").Key);
        Assert.Equal("other", catalog.Resolve("b/other").UpstreamModelId);
    }

    [Theory]
    [InlineData("sameModelAs", "null")]
    [InlineData("sameModelAs", "false")]
    [InlineData("sameModelAs", "\"  \"")]
    [InlineData("sameModelAs", "\"missing/model\"")]
    [InlineData("sameModelAs", "\"route\"")]
    [InlineData("sameProviderAs", "123")]
    [InlineData("sameProviderAs", "\"\"")]
    [InlineData("sameProviderAs", "\"missing\"")]
    [InlineData("sameProviderAs", "\"route\"")]
    public async Task Invalid_declared_references_leave_installed_configuration_intact(string field, string raw)
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(temp.Path);
        var document = Document();
        var original = document.ToJsonString();
        await configuration.SaveAsync(new JsonObject { ["yaml"] = original });
        var scope = field == "sameModelAs" ? document["providers"]!["b"]!["models"]![2]!.AsObject()
            : document["providers"]!["b"]!.AsObject();
        scope[field] = JsonNode.Parse(raw);
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() }));
        Assert.Contains(field, error.Message);
        Assert.Equal(original, await File.ReadAllTextAsync(configuration.ActivePath));
        Assert.True(configuration.Capture().Resolve("b/m").HistoryCompatibility.Matches("a/m", "b/m"));
    }

    [Fact]
    public void Wrong_scopes_and_model_provider_or_mixed_cycles_are_configuration_errors()
    {
        foreach (var raw in new[]
        {
            """{"providers":{"a":{"sameModelAs":"m","models":["m"]}}}""",
            """{"providers":{"a":{"models":[{"id":"m","sameProviderAs":"a"}]}}}""",
            """{"defaults":{"sameProviderAs":"a"},"providers":{"a":{}}}""",
            """{"providers":{"a":{"providerType":"session-hash","targets":["b"],"sameProviderAs":"b"},"b":{}}}""",
            """{"providers":{"a":{"models":[{"id":"m","sameModelAs":"n"},{"id":"n","sameModelAs":"m"}]}}}""",
            """{"providers":{"a":{"sameProviderAs":"b","models":["m"]},"b":{"sameProviderAs":"a","models":["other"]}}}""",
            """{"providers":{"a":{"sameProviderAs":"b","models":["m"]},"b":{"models":[{"id":"m","sameModelAs":"a/m"}]}}}""",
        })
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(JsonNode.Parse(raw)!.AsObject(), new JsonObject()));
    }

    [Fact]
    public async Task Structured_save_preserves_provider_mapping_and_retained_model_override()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(temp.Path);
        var document = JsonNode.Parse("""
            {"providers":{"a":{"models":["m","other"]},"b":{"sameProviderAs":"a",
              "models":[{"id":"m","sameModelAs":"a/other"}]}}}
            """)!.AsObject();
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        await configuration.SaveAsync(JsonNode.Parse("""
            {"providers":[{"id":"a","models":"m,other"},{"id":"b","models":"m"}]}
            """)!.AsObject());
        var leaf = configuration.Capture().Resolve("b/m");
        Assert.True(leaf.HistoryCompatibility.Matches("b/m", "a/other"));
        Assert.False(leaf.HistoryCompatibility.Matches("b/m", "a/m"));
        var saved = ConfigurationYaml.Parse(await File.ReadAllTextAsync(configuration.ActivePath), "models config");
        Assert.Equal("a", saved["providers"]!["b"]!["sameProviderAs"]!.GetValue<string>());
        Assert.Equal("a/other", saved["providers"]!["b"]!["models"]![0]!["sameModelAs"]!.GetValue<string>());
    }

    private static JsonObject History() => JsonNode.Parse("""
        {"role":"model","__meta":{"modelId":"a/m","seq":1},
         "providerMeta":{"sourceModelId":"a/m","providerSpecificFields":{"opaque":"provider-field"}},
         "parts":[{"thinking":"private-thinking","providerMeta":{"thinkingSummaries":["private-summary"],"encryptedThinking":"private-cipher","signature":"private-signature","redactedThinking":"private-redacted"}},
           {"text":"answer","providerMeta":{"openaiResponses":{"sourceModelId":"a/m","annotations":[{"type":"url_citation","title":"native-citation"}]}}},
           {"providerMeta":{"openaiResponses":{"sourceModelId":"a/m","outputItem":{"type":"web_search_call","id":"native-search","status":"completed","action":{"type":"search","query":"synthetic"}}}}}]}
        """)!.AsObject();

    [Fact]
    public async Task New_catalog_applies_to_old_canonical_history_and_existing_request_capture_keeps_its_mapping()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(temp.Path);
        var document = Document();
        document["providers"]!["b"]!.AsObject().Remove("sameProviderAs");
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        var old = configuration.Capture().Resolve("b/m");
        var history = History();
        var canonical = history.ToJsonString();
        Assert.DoesNotContain("private-cipher", ConcreteRequestHistory.Prepare([history], old.Key, old.HistoryCompatibility)[0].ToJsonString());
        document["providers"]!["b"]!["sameProviderAs"] = "a";
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        var current = configuration.Capture().Resolve("b/m");
        var prepared = ConcreteRequestHistory.Prepare([history], current.Key, current.HistoryCompatibility);
        Assert.Contains("private-cipher", prepared[0].ToJsonString());
        Assert.Equal("a/m", SessionWait.Text(prepared[0]["providerMeta"]?["sourceModelId"]));
        Assert.False(old.HistoryCompatibility.Matches("a/m", "b/m"));
        Assert.Equal(canonical, history.ToJsonString());
    }

    [Theory]
    [InlineData("Btw", "btw")]
    [InlineData("CompactPlan", "compact-plan")]
    [InlineData("LowLevel", "toolscript-one-shot")]
    public async Task Shared_request_owner_uses_compatibility_for_detached_planning_and_one_shot_scopes(string scope, string purpose)
    {
        await using var peer = new ScriptedResponsesSequenceServer(1, (_, stream, _) =>
            LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Encoding.UTF8.GetBytes(
                "data: " + new JsonObject { ["type"] = "response.completed", ["response"] = ResponsesWsTests.Response(1) }.ToJsonString() + "\n\n")));
        using var http = new HttpClient();
        var document = Document();
        foreach (var provider in document["providers"]!.AsObject().Select(pair => pair.Value).OfType<JsonObject>())
            if (provider["targets"] is null)
                provider["baseUrl"] = peer.BaseUri.ToString();
        var catalog = HostModels.Parse(document, new JsonObject());
        var requests = new ModelRequestOwner(http, new(peer.BaseUri, "unused", "unused", "", "", 1000), new ModelRouting());
        var canonical = History();
        var original = canonical.ToJsonString();
        var result = await requests.RequestAsync("s", catalog, "b/m", null, "cache", "turn", [canonical, ResponsesWsTests.Message("user", "continue")],
            (_, _) => Task.FromResult(""), null, null, null, null, default, Enum.Parse<ModelRequestScope>(scope), journalPurpose: purpose);
        var wire = JsonNode.Parse((await peer.RequestAt(0)).Body)!.ToJsonString();
        Assert.Contains("private-cipher", wire);
        Assert.Contains("native-citation", wire);
        Assert.Contains("native-search", wire);
        Assert.Equal("b/m", SessionWait.Text(result.AssistantMessage?["__meta"]?["modelId"]));
        Assert.Equal(original, canonical.ToJsonString());
    }

    [Fact]
    public async Task Retry_keeps_the_captured_mapping_while_a_later_request_uses_the_installed_catalog()
    {
        using var temp = new TempDirectory();
        var bodies = new List<string>();
        await using var peer = new ScriptedResponsesSequenceServer(3, (index, stream, captured) =>
        {
            bodies.Add(captured.Body);
            var response = "data: " + new JsonObject { ["type"] = "response.completed", ["response"] = ResponsesWsTests.Response(index + 1) }.ToJsonString() + "\n\n";
            return LoopbackResponsesServer.WriteResponseAsync(stream, index == 0 ? 500 : 200,
                "text/event-stream", Encoding.UTF8.GetBytes(response));
        });
        var configuration = new ModelConfiguration(temp.Path);
        var document = Document();
        document["providers"]!["b"]!["baseUrl"] = peer.BaseUri.ToString();
        await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        using var http = new HttpClient();
        var owner = new ModelRequestOwner(http, new(peer.BaseUri, "unused", "unused", "", "", 1000), new ModelRouting(), (_, _) => Task.CompletedTask);
        var history = new[] { History(), ResponsesWsTests.Message("user", "continue") };
        await owner.RequestAsync("s", configuration.Capture(), "b/m", null, "cache", "turn", history,
            (_, _) => Task.FromResult(""), async _ =>
            {
                document["providers"]!["b"]!.AsObject().Remove("sameProviderAs");
                await configuration.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
                return false;
            }, null, null, null, default);
        await owner.RequestAsync("s", configuration.Capture(), "b/m", null, "cache", "next-turn", history,
            (_, _) => Task.FromResult(""), null, null, null, null, default);
        Assert.Equal(3, bodies.Count);
        Assert.Contains("private-cipher", bodies[0]);
        Assert.Contains("private-cipher", bodies[1]);
        Assert.DoesNotContain("private-cipher", bodies[2]);
    }
}
