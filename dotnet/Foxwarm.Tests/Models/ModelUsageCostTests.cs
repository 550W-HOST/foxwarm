using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class ModelUsageCostTests
{
    private static JsonObject Prices(double factor = 1) =>
        new()
        {
            ["cached"] = factor,
            ["input"] = 2 * factor,
            ["output"] = 3 * factor,
        };

    private static JsonObject Document(Uri uri, string protocol, double factor = 1) =>
        new()
        {
            ["default"] = "alias",
            ["providers"] = new JsonObject
            {
                ["alias"] = "priced",
                ["priced"] = new JsonObject
                {
                    ["providerType"] = protocol,
                    ["baseUrl"] = uri.ToString(),
                    ["extraFields"] =
                        protocol == "anthropic"
                            ? new JsonObject { ["stream"] = false }
                            : new JsonObject(),
                    ["models"] = new JsonArray(
                        new JsonObject
                        {
                            ["id"] = "wire",
                            ["pricing"] = Prices(factor),
                        }
                    ),
                },
            },
        };

    private static string Body(string protocol) =>
        protocol switch
        {
            "openai-completions" =>
                "data: {\"choices\":[{\"delta\":{\"content\":\"done\"}}],\"usage\":{\"prompt_tokens\":10,\"prompt_tokens_details\":{\"cached_tokens\":8},\"completion_tokens\":5,\"completion_tokens_details\":{\"reasoning_tokens\":3}}}\n\ndata: [DONE]\n\n",
            "anthropic" => """
                {"content":[{"type":"text","text":"done"}],"usage":{"input_tokens":1,"cache_creation_input_tokens":1,"cache_read_input_tokens":8,"output_tokens":5}}
                """,
            _ =>
                "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}],\"usage\":{\"input_tokens\":10,\"input_tokens_details\":{\"cached_tokens\":8},\"output_tokens\":5,\"output_tokens_details\":{\"reasoning_tokens\":3}}}}\n\n",
        };

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Raw_Setup_pricing_save_records_cost_on_the_next_normal_request(bool providerLeaf)
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            (_, stream, _) => LoopbackResponsesServer.WriteResponseAsync(
                stream, 200, "text/event-stream", Encoding.UTF8.GetBytes(Body("openai-responses")))
        );
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(HostPaths.ForDataRoot(temp.Path, environment: _ => null));
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
        var leaf = providerLeaf
            ? "    pricing: { cached: 1, input: 2, output: 3 }\n"
            : "    models:\n      - id: wire\n        pricing: { cached: 1, input: 2, output: 3 }\n";
        var raw = "# user-authored prices\ndefault: priced\nproviders:\n  priced:\n    providerType: openai-responses\n    baseUrl: " + peer.BaseUri + "\n" + leaf;
        var saved = await client.PostAsJsonAsync("/api/setup/models", new { yaml = raw });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        Assert.Equal(raw, await File.ReadAllTextAsync(configuration.ActivePath));
        Assert.Equal(2, configuration.Capture().Resolve("priced").Configuration["pricing"]!["input"]!.GetValue<double>());
        var status = (await client.GetFromJsonAsync<JsonObject>("/api/setup/status"))!;
        Assert.Equal(raw, status["models"]!["rawYaml"]!.GetValue<string>());
        var created = await client.PostAsJsonAsync("/api/sessions", new { agentId = "main", sessionId = "setup-pricing" });
        Assert.True(created.IsSuccessStatusCode);
        var sessionId = (await created.Content.ReadFromJsonAsync<JsonObject>())!["sessionId"]!.GetValue<string>();
        var triggered = await client.PostAsJsonAsync("/trigger", new { text = "exercise saved pricing", sessionId });
        Assert.True(triggered.IsSuccessStatusCode, await triggered.Content.ReadAsStringAsync());
        // Observe the normal HTTP consumer, not an internal accounting shortcut.
        JsonObject? history = null;
        var deadline = DateTime.UtcNow.AddSeconds(15);
        do
        {
            history = await client.GetFromJsonAsync<JsonObject>("/api/sessions/" + Uri.EscapeDataString(sessionId) + "/history");
            if (history?["messages"]!.AsArray().Any(row => row?["__meta"]?["usage"]?["cost"] is not null) == true)
                break;
            await Task.Delay(25);
        } while (DateTime.UtcNow < deadline);
        var model = Assert.Single(history!["messages"]!.AsArray(), row => row?["role"]?.ToString() == "model");
        Assert.Equal(.000027, model!["__meta"]!["usage"]!["cost"]!.GetValue<double>(), 10);
        var persisted = await new PersistentSessionAuthorityStore(temp.Path, sessionId).LoadAsync(sessionId);
        Assert.Equal(.000027, persisted!.AuthorityEnvelope["stats"]!["totalCost"]!.GetValue<double>(), 10);
    }

    [Theory]
    [InlineData("openai-responses")]
    [InlineData("openai-completions")]
    [InlineData("anthropic")]
    public async Task Installed_prices_follow_captured_concrete_model_through_normal_requests_journal_and_persistence(
        string protocol
    )
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
            {
                if (index == 0)
                {
                    started.TrySetResult();
                    await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                }
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    protocol == "anthropic" ? "application/json" : "text/event-stream",
                    Encoding.UTF8.GetBytes(Body(protocol))
                );
            }
        );
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, environment: _ => null);
        var config = new ModelConfiguration(paths);
        await config.SaveAsync(
            new JsonObject { ["yaml"] = Document(peer.BaseUri, protocol).ToJsonString() }
        );
        var defaults = new ResponsesClientOptions(peer.BaseUri, "wire", "priced/wire", "", "", 713);
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            defaults,
            new HostModels(config)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "cost", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        async Task Run()
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("next"));
            await owner
                .Registry.Runner.ProcessQueueAsync(owner.Id)
                .WaitAsync(TimeSpan.FromSeconds(20));
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        }
        var first = Run();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(15));
        // Reload is live, but the running physical request keeps its captured leaf rates.
        await config.SaveAsync(
            new JsonObject { ["yaml"] = Document(peer.BaseUri, protocol, 2).ToJsonString() }
        );
        release.TrySetResult();
        await first;
        var firstMessage = owner.History().Last(row => row["role"]?.ToString() == "model");
        Assert.Equal("priced/wire", firstMessage["__meta"]!["modelId"]!.GetValue<string>());
        Assert.Equal(
            0.000027,
            SessionCatalog.Number(firstMessage["__meta"]?["usage"]?["cost"])!.Value,
            10
        );
        await Run();
        var stats = owner.Entry.Snapshot().AuthorityEnvelope["stats"]!;
        Assert.Equal(0.000081, SessionCatalog.Number(stats["totalCost"])!.Value, 10);
        Assert.Equal(0.000054, SessionCatalog.Number(stats["lastUsage"]?["cost"])!.Value, 10);
        Assert.Equal(16, SessionCatalog.Number(stats["totalCachedTokens"]));
        Assert.Equal(4, SessionCatalog.Number(stats["totalInputTokens"]));
        Assert.Equal(10, SessionCatalog.Number(stats["totalOutputTokens"]));
        Assert.Equal(
            0.000027,
            SessionCatalog
                .Number(
                    owner
                        .History()
                        .First(row => row["role"]?.ToString() == "model")["__meta"]
                        ?["usage"]?["cost"]
                )!
                .Value,
            10
        );
        var reopened = await new PersistentSessionAuthorityStore(temp.Path, owner.Id).LoadAsync(
            owner.Id
        );
        Assert.True(JsonNode.DeepEquals(stats, reopened!.AuthorityEnvelope["stats"]));
        var view = new SessionListQueries(new SessionRuntime(manager));
        Assert.Equal(
            0.000081,
            SessionCatalog.Number(view.Projection(owner.Id)?["tokenUsage"]?["cost"])!.Value,
            10
        );
        Assert.Equal(0.000081, SessionCatalog.Number(view.GlobalSummary()["cost"])!.Value, 10);
        Assert.Equal(
            0.000081,
            SessionCatalog.Number(manager.Catalog.Get(owner.Id)?["stats"]?["totalCost"])!.Value,
            10
        );
        var status = await manager.ObserveAsync(
            owner,
            "session",
            new JsonObject { ["action"] = "status" }
        );
        Assert.Contains("estimated cost=< $0.0001 USD", status["output"]!.GetValue<string>());
        Assert.Contains(
            "total estimated cost: < $0.0001 USD",
            status["output"]!.GetValue<string>()
        );
        var journals = await manager.Journal.ListAsync(owner.Id, null, null, null, 10);
        Assert.Equal(2, journals.Count);
        var savedCosts = new List<double>();
        foreach (var item in journals)
        {
            var journal = await manager.Journal.ReconstructAsync(
                item!["requestId"]!.GetValue<string>()
            );
            var result = journal["attempts"]!.AsArray().Last()!["result"]!["result"]!;
            savedCosts.Add(SessionCatalog.Number(result["usage"]?["cost"])!.Value);
            Assert.Equal(2, SessionCatalog.Number(result["usage"]?["inputTokens"]));
        }
        Assert.Equal(0.000027, savedCosts.Min(), 10);
        Assert.Equal(0.000054, savedCosts.Max(), 10);
        var fork = await manager.ForkAsync(owner, "copy");
        Assert.Null(fork.Entry.Snapshot().AuthorityEnvelope["stats"]?["totalCost"]);
        Assert.Contains(fork.History(), row => row["__meta"]?["usage"]?["cost"] is not null);
        await manager.ClearAsync(owner);
        Assert.Equal(
            0.000081,
            SessionCatalog.Number(view.Projection(owner.Id)?["tokenUsage"]?["cost"])!.Value,
            10
        );
        Assert.Equal(0.000081, SessionCatalog.Number(view.GlobalSummary()["cost"])!.Value, 10);
    }

    [Fact]
    public async Task Committed_zero_cost_is_visible_in_bounded_live_summaries_before_catalog_publication_recovers()
    {
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, _) =>
            {
                started.TrySetResult();
                await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Body("openai-responses"))
                );
            }
        );
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        await config.SaveAsync(
            new JsonObject
            {
                ["yaml"] = Document(peer.BaseUri, "openai-responses", 0).ToJsonString(),
            }
        );
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "priced/wire", "", "", 713);
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            options,
            new HostModels(config)
        );
        await manager.LoadAsync();
        var parent = await manager.CreateNamedAsync("main", "parent", null, null);
        var owner = await manager.CreateNamedAsync(
            "main",
            "child",
            null,
            null,
            parentSessionId: parent.Id
        );
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("next"));
        var running = owner.StartProcessing();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(15));
        manager.Catalog.BeforeAuthorityProjection = _ =>
            throw new IOException("Owned catalog publication fault");
        release.TrySetResult();
        try
        {
            var error = await Record.ExceptionAsync(() =>
                running.WaitAsync(TimeSpan.FromSeconds(20))
            );
            Assert.Null(error);
            Assert.IsType<AuthorityCommittedException>(owner.Entry.LastBackgroundProcessorFailure);
            Assert.Null(manager.Catalog.Get(owner.Id)?["stats"]?["totalCost"]);
            Assert.Equal(
                0,
                SessionCatalog.Number(
                    owner.Entry.Snapshot().AuthorityEnvelope["stats"]?["totalCost"]
                )
            );
            var queries = new SessionListQueries(new SessionRuntime(manager));
            Assert.Equal(
                0,
                SessionCatalog.Number(queries.Projection(owner.Id)?["tokenUsage"]?["cost"])
            );
            Assert.Equal(0, SessionCatalog.Number(queries.GlobalSummary()["cost"]));
            Assert.Equal(0, SessionCatalog.Number(queries.Descendants(parent.Id, 10)["cost"]));
        }
        finally
        {
            manager.Catalog.BeforeAuthorityProjection = null;
        }
        await owner.Entry.SaveLane.SaveStrictAsync();
        Assert.Equal(
            0,
            SessionCatalog.Number(manager.Catalog.Get(owner.Id)?["stats"]?["totalCost"])
        );
    }

    [Fact]
    public async Task Failover_prices_only_the_accepted_concrete_leaf_and_lowlevel_requests_do_not_add_session_totals()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    index == 0 ? 503 : 200,
                    index == 0 ? "application/json" : "text/event-stream",
                    Encoding.UTF8.GetBytes(index == 0 ? "unavailable" : Body("openai-responses"))
                )
        );
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var doc = Document(peer.BaseUri, "openai-responses");
        var providers = doc["providers"]!.AsObject();
        providers["other"] = providers["priced"]!.DeepClone();
        providers["other"]!["models"]![0]!["pricing"] = Prices(10);
        providers["alias"] = new JsonObject
        {
            ["providerType"] = "failover",
            ["targets"] = new JsonArray("priced", "other"),
            ["failureThreshold"] = 1,
        };
        await config.SaveAsync(new JsonObject { ["yaml"] = doc.ToJsonString() });
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "priced/wire", "", "", 713);
        using var http = new HttpClient();
        using var journal = new LlmRequestJournalStore(temp.Path);
        var requests = new ModelRequestOwner(
            http,
            options,
            new ModelRouting(),
            (_, _) => Task.CompletedTask,
            journal: journal
        );
        var result = await requests
            .RequestAsync(
                "side",
                config.Capture(),
                "alias",
                null,
                "cache",
                "turn",
                [],
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                default,
                ModelRequestScope.LowLevel
            )
            .WaitAsync(TimeSpan.FromSeconds(15));
        Assert.Equal(2, peer.RequestCount);
        Assert.Equal(
            "other/wire",
            result.AssistantMessage!["__meta"]!["modelId"]!.GetValue<string>()
        );
        Assert.Equal(.000270, SessionCatalog.Number(result.Usage?["cost"])!.Value, 10);
        Assert.Equal(
            result.Usage!.ToJsonString(),
            result.AssistantMessage["__meta"]!["usage"]!.ToJsonString()
        );
        Assert.False(Directory.Exists(Path.Combine(temp.Path, "state", "sessions")));
        var item = Assert.Single(await journal.ListAsync("side", null, null, null, 10));
        var saved = await journal.ReconstructAsync(item!["requestId"]!.GetValue<string>());
        var attempts = saved["attempts"]!.AsArray();
        Assert.Equal(2, attempts.Count);
        Assert.Equal(
            .000270,
            SessionCatalog.Number(attempts.Last()?["result"]?["result"]?["usage"]?["cost"])!.Value,
            10
        );
    }

    [Theory]
    [InlineData("null")]
    [InlineData("{}")]
    [InlineData("{\"cached\":0,\"input\":1}")]
    [InlineData("{\"cached\":0,\"input\":1,\"output\":null}")]
    [InlineData("{\"cached\":0,\"input\":1,\"output\":\"2\"}")]
    [InlineData("{\"cached\":0,\"input\":1,\"output\":-1}")]
    [InlineData("{\"cached\":0,\"input\":1,\"output\":2,\"currency\":\"EUR\"}")]
    public async Task Incomplete_or_invalid_prices_do_not_replace_installed_configuration(
        string raw
    )
    {
        using var temp = new TempDirectory();
        var config = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var document = Document(new Uri("http://127.0.0.1:1"), "openai-responses");
        await config.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() });
        var before = await File.ReadAllTextAsync(config.ActivePath);
        document["providers"]!["priced"]!["models"]![0]!["pricing"] = JsonNode.Parse(
            raw
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            config.SaveAsync(new JsonObject { ["yaml"] = document.ToJsonString() })
        );
        Assert.Equal(before, await File.ReadAllTextAsync(config.ActivePath));
        Assert.Equal(
            1,
            SessionCatalog.Number(
                config.Capture().Resolve("priced").Configuration["pricing"]?["cached"]
            )
        );
    }

    [Theory]
    [InlineData("named")]
    [InlineData("virtual")]
    [InlineData("defaults")]
    public void Prices_have_no_provider_virtual_or_global_inheritance(string scope)
    {
        var doc = Document(new Uri("http://127.0.0.1:1"), "openai-responses");
        if (scope == "defaults")
            doc["defaults"] = new JsonObject { ["pricing"] = Prices() };
        else if (scope == "virtual")
            doc["providers"]!["alias"] = new JsonObject
            {
                ["providerType"] = "session-hash",
                ["targets"] = new JsonArray("priced"),
                ["pricing"] = Prices(),
            };
        else
            doc["providers"]!["priced"]!["pricing"] = Prices();
        Assert.Throws<InvalidDataException>(() => HostModels.Parse(doc, new JsonObject()));
    }

    [Fact]
    public void Zero_prices_and_missing_usage_remain_distinct_and_incomplete_counts_do_not_price_a_partial_result()
    {
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["providers"] = new JsonObject
                {
                    ["free"] = new JsonObject { ["pricing"] = Prices(0) },
                    ["legacy"] = new JsonObject(),
                },
            },
            new JsonObject()
        );
        var usage = new JsonObject
        {
            ["cachedTokens"] = 8,
            ["inputTokens"] = 2,
            ["outputTokens"] = 5,
            ["reasoningTokens"] = 3,
        };
        var result = new ChatResult(null, usage);
        Assert.Equal(
            0,
            SessionCatalog.Number(ModelUsageCost.Complete(catalog.Resolve("free"), result)?["cost"])
        );
        Assert.Null(ModelUsageCost.Complete(catalog.Resolve("legacy"), result)?["cost"]);
        Assert.Null(ModelUsageCost.Complete(catalog.Resolve("free"), new ChatResult(null)));
        usage["inputTokens"] = null;
        Assert.Null(ModelUsageCost.Complete(catalog.Resolve("free"), result)?["cost"]);
        usage["inputTokens"] = -1;
        Assert.Null(ModelUsageCost.Complete(catalog.Resolve("free"), result)?["cost"]);
        Assert.False(usage.ContainsKey("cost"));
    }
}
