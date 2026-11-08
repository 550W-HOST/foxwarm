using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ModelCatalogTests
{
    private static JsonObject Priced(string id, double cached, double input, double output) =>
        new()
        {
            ["id"] = id,
            ["pricing"] = new JsonObject
            {
                ["cached"] = cached,
                ["input"] = input,
                ["output"] = output,
            },
        };

    private static JsonObject Root(JsonNode? catalog, bool includeCatalog = true)
    {
        var root = new JsonObject
        {
            ["default"] = "a",
            ["providers"] = new JsonObject
            {
                ["a"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = "http://localhost",
                    ["models"] = new JsonArray(Priced("m", .1, 1, 5)),
                },
                ["b"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = "http://localhost",
                    ["models"] = new JsonArray(Priced("x", .1, 1, 5), Priced("y", .2, 2, 10)),
                },
                ["c"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = "http://localhost",
                    ["models"] = new JsonArray("plain"),
                },
                ["quick"] = "a",
                ["same"] = new JsonObject
                {
                    ["providerType"] = "failover",
                    ["targets"] = new JsonArray("a", "b/x"),
                },
                ["mixed"] = new JsonObject
                {
                    ["providerType"] = "failover",
                    ["targets"] = new JsonArray("a", "b/y"),
                },
            },
        };
        if (includeCatalog)
            root["catalog"] = catalog;
        return root;
    }

    private static HostModels Parse(JsonNode? catalog) => HostModels.Parse(Root(catalog), new());

    [Fact]
    public void Catalog_keeps_document_order_and_accepts_alias_virtual_qualified_and_bare_keys()
    {
        var parsed = Parse(
            JsonNode.Parse(
                """
                {"quick":"Alias entry","b/y":"Qualified entry","a":"Bare single-model key","same":" Virtual entry "}
                """
            )
        );
        Assert.Equal(
            ["quick", "b/y", "a", "same"],
            parsed.Catalog.Select(entry => entry.Key).ToArray()
        );
        Assert.Equal("Virtual entry", parsed.Catalog[3].Description);
        // Advisory only: uncataloged keys still resolve and routing is unchanged.
        Assert.Equal("c/plain", parsed.Resolve("c").Key);
        Assert.Equal("a", parsed.DefaultKey);
    }

    [Fact]
    public void Absent_null_and_empty_catalogs_are_empty()
    {
        Assert.Empty(HostModels.Parse(Root(null, includeCatalog: false), new()).Catalog);
        Assert.Empty(Parse(null).Catalog);
        Assert.Empty(Parse(new JsonObject()).Catalog);
    }

    [Theory]
    [InlineData("{\"missing\":\"Unknown key\"}")]
    [InlineData("{\"b\":\"Provider key of a multi-model provider is not selectable\"}")]
    [InlineData("{\"a\":\"\"}")]
    [InlineData("{\"a\":\"   \"}")]
    [InlineData("{\"a\":7}")]
    [InlineData("{\"a\":null}")]
    [InlineData("{\"a\":[\"list\"]}")]
    [InlineData("[\"a\"]")]
    [InlineData("\"a\"")]
    public void Catalog_configuration_errors_are_rejected(string catalog)
    {
        Assert.Throws<InvalidDataException>(() => Parse(JsonNode.Parse(catalog)));
    }

    [Fact]
    public void Catalog_keys_resolve_within_the_same_snapshot_and_leaves_follow_virtual_targets()
    {
        var parsed = Parse(new JsonObject());
        Assert.Equal(
            ["a/m", "b/x"],
            parsed.ReachableLeaves("same").Select(leaf => leaf.Key).ToArray()
        );
        Assert.Equal(["a/m"], parsed.ReachableLeaves("quick").Select(leaf => leaf.Key).ToArray());
        Assert.Equal(["a/m"], parsed.ReachableLeaves("a/m").Select(leaf => leaf.Key).ToArray());
        Assert.Empty(parsed.ReachableLeaves("missing"));
        Assert.Equal((.1, 1, 5), parsed.SharedPrice("same"));
        Assert.Null(parsed.SharedPrice("mixed"));
        Assert.Null(parsed.SharedPrice("c"));
    }

    private static async Task<string> SnapshotAsync(
        JsonNode? catalog,
        string concreteModelId,
        bool includeCatalog = true
    )
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        var agents = new AgentCatalog(temp.Path, work);
        var memory = new AgentMemory(
            agents,
            new Skills(agents, Path.Combine(temp.Path, "skills")),
            models: HostModels.Parse(Root(catalog, includeCatalog), new())
        );
        return await memory.BuildAsync("main", "s", concreteModelId);
    }

    private static string Block(string snapshot)
    {
        var start = snapshot.IndexOf("<available_models>", StringComparison.Ordinal);
        var end = snapshot.IndexOf("</available_models>", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start, snapshot);
        return snapshot[start..(end + "</available_models>".Length)];
    }

    [Fact]
    public async Task Snapshot_renders_catalog_in_order_with_escaping_prices_and_current_marker()
    {
        var snapshot = await SnapshotAsync(
            JsonNode.Parse(
                """
                {"c":"Plain <fast> & cheap","same":"Failover over equal prices","mixed":"Differing prices","quick":"Alias of the current model","b/y":"Other leaf"}
                """
            ),
            "a/m"
        );
        Assert.Equal(
            string.Join(
                "\n",
                "<available_models>",
                "  <model><key>c</key><description>Plain &lt;fast&gt; &amp; cheap</description></model>",
                "  <model current=\"true\"><key>same</key><description>Failover over equal prices</description><price cached=\"0.1\" input=\"1\" output=\"5\" unit=\"USD per 1M tokens\"/></model>",
                "  <model current=\"true\"><key>mixed</key><description>Differing prices</description></model>",
                "  <model current=\"true\"><key>quick</key><description>Alias of the current model</description><price cached=\"0.1\" input=\"1\" output=\"5\" unit=\"USD per 1M tokens\"/></model>",
                "  <model><key>b/y</key><description>Other leaf</description><price cached=\"0.2\" input=\"2\" output=\"10\" unit=\"USD per 1M tokens\"/></model>",
                "</available_models>"
            ),
            Block(snapshot)
        );
        // The catalog sits with the skills catalog layer, ahead of the directories footer.
        Assert.True(
            snapshot.IndexOf("<available_models>", StringComparison.Ordinal)
                < snapshot.IndexOf("--- DIRECTORIES ---", StringComparison.Ordinal)
        );
        Assert.DoesNotContain(
            "current=\"true\"",
            Block(await SnapshotAsync(JsonNode.Parse("{\"c\":\"Plain\"}"), "a/m"))
        );
    }

    [Fact]
    public async Task Snapshot_omits_the_catalog_when_it_is_empty()
    {
        Assert.DoesNotContain(
            "available_models",
            await SnapshotAsync(null, "a/m", includeCatalog: false)
        );
        Assert.DoesNotContain("available_models", await SnapshotAsync(new JsonObject(), "a/m"));
    }

    private static ModelConfiguration KeyedConfiguration(TempDirectory temp)
    {
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        File.WriteAllText(
            Path.Combine(temp.Path, "state", "config.yaml"),
            "llm:\n  openaiApiKey: synthetic-fallback-key\n"
        );
        return new ModelConfiguration(HostPaths.ForDataRoot(temp.Path, environment: _ => null));
    }

    private const string CatalogYaml = """
        default: a/wire-a
        providers:
          a: {models: [wire-a, wire-a2]}
          b: {models: [wire-b]}
        catalog:
          b: Second provider
          a/wire-a2: Second model of the first provider
          a/wire-a: First model
        """;

    private static async Task<JsonObject> SavedAsync(ModelConfiguration configuration) =>
        ConfigurationYaml.Parse(
            await File.ReadAllTextAsync(configuration.ActivePath),
            "models config"
        );

    [Fact]
    public async Task Raw_yaml_saves_publish_the_catalog_and_invalid_catalogs_leave_the_active_file()
    {
        using var temp = new TempDirectory();
        var configuration = KeyedConfiguration(temp);
        await configuration.SaveAsync(new JsonObject { ["yaml"] = CatalogYaml });
        Assert.Equal(
            ["b", "a/wire-a2", "a/wire-a"],
            configuration.Capture().Catalog.Select(entry => entry.Key).ToArray()
        );
        var before = await File.ReadAllTextAsync(configuration.ActivePath);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.SaveAsync(
                new JsonObject { ["yaml"] = CatalogYaml.Replace("b: Second", "gone: Second") }
            )
        );
        Assert.Equal(before, await File.ReadAllTextAsync(configuration.ActivePath));
        Assert.Equal(3, configuration.Capture().Catalog.Count);
        // The native set_config install lane runs the same validation.
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.InstallAsync(
                "models",
                _ =>
                    Task.FromResult(
                        System.Text.Encoding.UTF8.GetBytes(
                            CatalogYaml.Replace("First model", "\"\"")
                        )
                    )
            )
        );
        Assert.Equal(before, await File.ReadAllTextAsync(configuration.ActivePath));
    }

    [Fact]
    public async Task Structured_saves_keep_the_catalog_and_drop_entries_whose_key_no_longer_resolves()
    {
        using var temp = new TempDirectory();
        var configuration = KeyedConfiguration(temp);
        await configuration.SaveAsync(new JsonObject { ["yaml"] = CatalogYaml });

        // Providers unchanged: the catalog and its order survive.
        await configuration.SaveAsync(
            JsonNode
                .Parse(
                    """{"default":"a/wire-a","providers":[{"id":"a","models":"wire-a\nwire-a2"},{"id":"b","models":"wire-b"}]}"""
                )!
                .AsObject()
        );
        Assert.Equal(
            ["b", "a/wire-a2", "a/wire-a"],
            (await SavedAsync(configuration))["catalog"]!
                .AsObject()
                .Select(pair => pair.Key)
                .ToArray()
        );

        // Removing a model and renaming provider b drops exactly the dangling entries.
        await configuration.SaveAsync(
            JsonNode
                .Parse(
                    """{"default":"a/wire-a","providers":[{"id":"a","models":"wire-a"},{"id":"renamed","models":"wire-b"}]}"""
                )!
                .AsObject()
        );
        var saved = await SavedAsync(configuration);
        Assert.Equal(["a/wire-a"], saved["catalog"]!.AsObject().Select(pair => pair.Key).ToArray());
        Assert.Equal(
            ["a/wire-a"],
            configuration.Capture().Catalog.Select(entry => entry.Key).ToArray()
        );

        // Removing every cataloged key removes the section.
        await configuration.SaveAsync(
            JsonNode.Parse("""{"providers":[{"id":"z","models":"only"}]}""")!.AsObject()
        );
        Assert.False((await SavedAsync(configuration)).ContainsKey("catalog"));
    }

    [Fact]
    public async Task Structured_conversion_to_a_virtual_provider_drops_its_qualified_catalog_keys()
    {
        using var temp = new TempDirectory();
        var configuration = KeyedConfiguration(temp);
        await configuration.SaveAsync(new JsonObject { ["yaml"] = CatalogYaml });
        await configuration.SaveAsync(
            JsonNode
                .Parse(
                    """{"default":"b","providers":[{"id":"b","models":"wire-b"},{"id":"a","providerType":"session-hash","targets":["b"]}]}"""
                )!
                .AsObject()
        );
        var saved = await SavedAsync(configuration);
        Assert.Equal(["b"], saved["catalog"]!.AsObject().Select(pair => pair.Key).ToArray());
    }

    [Fact]
    public async Task Structured_saves_replace_the_catalog_with_a_submitted_list_in_order()
    {
        using var temp = new TempDirectory();
        var configuration = KeyedConfiguration(temp);
        await configuration.SaveAsync(new JsonObject { ["yaml"] = CatalogYaml });
        var form = JsonNode
            .Parse(
                """
                {"providers":[{"id":"a","models":"wire-a\nwire-a2"},{"id":"b","models":"wire-b"}],
                 "catalog":[{"key":"a/wire-a","description":"First"},{"key":"b","description":"Second"},{"key":"gone","description":"Dropped"}]}
                """
            )!
            .AsObject();
        await configuration.SaveAsync(form);
        Assert.Equal(
            [("a/wire-a", "First"), ("b", "Second")],
            configuration
                .Capture()
                .Catalog.Select(entry => (entry.Key, entry.Description))
                .ToArray()
        );
        form["catalog"] = JsonNode.Parse(
            """[{"key":"b","description":"One"},{"key":"b","description":"Two"}]"""
        );
        await Assert.ThrowsAsync<InvalidDataException>(() => configuration.SaveAsync(form));
        form["catalog"] = JsonNode.Parse("""[{"key":"b","description":" "}]""");
        await Assert.ThrowsAsync<InvalidDataException>(() => configuration.SaveAsync(form));
        form["catalog"] = new JsonArray();
        await configuration.SaveAsync(form);
        Assert.False((await SavedAsync(configuration)).ContainsKey("catalog"));
    }

    [Fact]
    public async Task Setup_save_roundtrips_the_catalog_through_the_status_the_editor_loads()
    {
        using var temp = new TempDirectory();
        var configuration = KeyedConfiguration(temp);
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] =
                    "default: a/wire-a\nproviders:\n  a: {models: [wire-a, wire-a2]}\n  b: {models: [wire-b]}\n",
            }
        );
        var settings = (await HttpServerSettings.CaptureAsync(configuration, temp.Path)) with
        {
            Port = 0,
            BindAddress = "127.0.0.1",
            Address = new("http://127.0.0.1", "", "/", false),
        };
        await using var host = await MainHost.CreateAsync([], configuration, settings);
        await host.StartAsync();
        using var client = new HttpClient
        {
            BaseAddress = new Uri(host.App.Urls.Single()),
            Timeout = TimeSpan.FromSeconds(20),
        };
        client.DefaultRequestHeaders.Authorization = new("Bearer", settings.Token);

        const string edited =
            "# kept comment\ndefault: a/wire-a\nproviders:\n  a: {models: [wire-a, wire-a2]}\n  b: {models: [wire-b]}\ncatalog:\n  b: Second provider, cheap\n  a/wire-a: First model\n";
        var saved = await client.PostAsJsonAsync("/api/setup/models", new { yaml = edited });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Equal(
            edited,
            (await client.GetFromJsonAsync<JsonObject>("/api/setup/status"))!["models"]![
                "rawYaml"
            ]!.GetValue<string>()
        );
        Assert.Equal(
            ["b", "a/wire-a"],
            configuration.Capture().Catalog.Select(entry => entry.Key).ToArray()
        );

        var before = await File.ReadAllBytesAsync(configuration.ActivePath);
        var rejected = await client.PostAsJsonAsync(
            "/api/setup/models",
            new { yaml = edited.Replace("b: Second", "missing: Second") }
        );
        Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
        Assert.Contains("missing", await rejected.Content.ReadAsStringAsync());
        Assert.Equal(before, await File.ReadAllBytesAsync(configuration.ActivePath));
    }
}
