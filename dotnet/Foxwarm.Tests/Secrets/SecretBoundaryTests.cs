using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Boundaries of the secret store: which literals are masked, which configuration changes
// are refused, how an unusable store fails, and that every history writer is masked.
public sealed class SecretBoundaryTests
{
    private const string ProviderKey = "sk-synthetic-provider-key-0001";

    private static ModelConfiguration Configuration(string root, JsonObject app, JsonObject models)
    {
        var data = Path.Combine(root, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        File.WriteAllText(Path.Combine(data, "state", "config.yaml"), app.ToJsonString());
        File.WriteAllText(Path.Combine(data, "state", "models.yaml"), models.ToJsonString());
        return new ModelConfiguration(HostPaths.ForDataRoot(data, root, environment: _ => null));
    }

    private static JsonObject Provider(string? baseUrl, string apiKey)
    {
        var provider = new JsonObject
        {
            ["providerType"] = "openai-responses",
            ["apiKey"] = apiKey,
            ["models"] = new JsonArray("m"),
        };
        if (baseUrl is not null)
            provider["baseUrl"] = baseUrl;
        return provider;
    }

    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(30);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Timed out waiting for the Session.");
            await Task.Delay(20);
        }
    }

    [Fact]
    public void Llm_base_urls_that_secret_using_providers_inherit_cannot_be_changed_by_the_model()
    {
        using var temp = new TempDirectory();
        new InstanceSecrets(Path.Combine(temp.Path, "data")).Store.Set("provider-key", ProviderKey);
        var configuration = Configuration(
            temp.Path,
            new JsonObject { ["vector"] = false },
            new JsonObject
            {
                ["default"] = "inherits/m",
                ["providers"] = new JsonObject
                {
                    ["inherits"] = Provider(null, "${secret:provider-key}"),
                    ["own-url"] = Provider("https://own.example.test/v1", "${secret:provider-key}"),
                },
            }
        );
        string Candidate(string field) =>
            new JsonObject
            {
                ["vector"] = false,
                ["llm"] = new JsonObject { [field] = "https://collector.example.test/v1" },
            }.ToJsonString();

        var error = Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireModelWritable(
                configuration,
                "config",
                Candidate("openaiBaseUrl")
            )
        );
        Assert.Contains("llm.openaiBaseUrl", error.Message);
        // No secret-using provider of the other family inherits its URL.
        SecretConfigurationChanges.RequireModelWritable(
            configuration,
            "config",
            Candidate("anthropicBaseUrl")
        );
    }

    [Fact]
    public void Only_credential_shaped_literals_are_masked()
    {
        var models = new JsonObject
        {
            ["providers"] = new JsonObject
            {
                ["router"] = new JsonObject
                {
                    ["apiKey"] = "sk-router-literal-key-000000",
                    ["extraHeaders"] = new JsonObject
                    {
                        ["Accept"] = "application/json",
                        ["HTTP-Referer"] = "https://foxwarm.example.test",
                        ["Authorization"] = "Bearer header-literal-token-0001",
                        ["X-Api-Key"] = "header-literal-api-key-0002",
                    },
                },
            },
        };
        var server = new JsonObject
        {
            ["url"] =
                "https://mcp.example.test/mcp?format=jsonlines-output&api_key=url-literal-key-0003",
            ["headers"] = new JsonObject { ["User-Agent"] = "synthetic-agent/1.0 (tests)" },
            ["args"] = new JsonArray(
                "mcp-remote",
                "https://mcp.example.test/sse",
                "--header",
                "Authorization: Bearer ghp_syntheticLiteralArgToken0000",
                "--header",
                "Accept: application/json",
                "--token=arg-literal-token-value-0004",
                "--api-key",
                "arg-literal-api-key-value-0005",
                "--transport",
                "streamable-http-only"
            ),
        };
        var redactor = new SecretRedactor(
            InstanceSecrets
                .Literals(SecretSinks.Models, models, path => "models." + path)
                .Concat(
                    InstanceSecrets.Literals(SecretSinks.McpServer, server, path => "mcp.s." + path)
                )
        );
        foreach (
            var masked in new[]
            {
                "sk-router-literal-key-000000",
                "header-literal-token-0001",
                "header-literal-api-key-0002",
                "url-literal-key-0003",
                "ghp_syntheticLiteralArgToken0000",
                "arg-literal-token-value-0004",
                "arg-literal-api-key-value-0005",
            }
        )
            Assert.DoesNotContain(masked, redactor.Redact("value: " + masked));
        foreach (
            var ordinary in new[]
            {
                "application/json",
                "https://foxwarm.example.test",
                "synthetic-agent/1.0 (tests)",
                "jsonlines-output",
                "streamable-http-only",
            }
        )
            Assert.Equal("value: " + ordinary, redactor.Redact("value: " + ordinary));
        // Short values are never known, so master exec keeps inherited variables like CI=1.
        var shortValues = new SecretRedactor([
            new KnownSecret("short", "1"),
            new KnownSecret("s2", "json"),
        ]);
        Assert.False(shortValues.IsKnownValue("1"));
        Assert.False(shortValues.IsKnownValue("json"));
        Assert.True(redactor.IsKnownValue("arg-literal-token-value-0004"));
    }

    [Theory]
    [InlineData("version")]
    [InlineData("malformed")]
    public void An_unusable_store_fails_only_its_consumers(string damage)
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        new InstanceSecrets(data).Store.Set("provider-key", ProviderKey);
        var store = Path.Combine(data, "state", "secrets.json");
        if (damage == "version")
        {
            var document = JsonNode.Parse(File.ReadAllText(store))!.AsObject();
            document["version"] = 2;
            File.WriteAllText(store, document.ToJsonString());
        }
        else
            File.WriteAllText(store, "{not json");
        var bytes = File.ReadAllBytes(store);
        var configuration = Configuration(
            temp.Path,
            new JsonObject
            {
                ["vector"] = false,
                ["asrService"] = new JsonObject
                {
                    ["url"] = "https://asr.example.test",
                    ["key"] = "${secret:provider-key}",
                },
            },
            new JsonObject
            {
                ["default"] = "literal/m",
                ["providers"] = new JsonObject
                {
                    ["literal"] = Provider(
                        "https://literal.example.test/v1",
                        "sk-literal-unrelated-key-0000"
                    ),
                    ["referenced"] = Provider(
                        "https://referenced.example.test/v1",
                        "${secret:provider-key}"
                    ),
                },
            }
        );
        var catalog = configuration.Capture();
        Assert.Equal(
            "sk-literal-unrelated-key-0000",
            catalog.All.First(model => model.ProviderKey == "literal").Token
        );
        Assert.Contains("provider-key", catalog.MissingSecrets["referenced"]);
        Assert.False(catalog.MissingSecrets.ContainsKey("literal"));
        _ = new Foxwarm.Asr.AsrProxy(configuration, default);
        Assert.True(configuration.Secrets.Locked);
        Assert.Contains("locked", configuration.Secrets.LockError!.Message);
        Assert.Throws<SecretStoreLockedException>(() =>
            configuration.Secrets.Store.Set("other", "synthetic-other-value-0001")
        );
        Assert.Equal(bytes, File.ReadAllBytes(store));
    }

    [Fact]
    public void Restoring_the_key_refreshes_a_catalog_resolved_while_locked()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var seed = new InstanceSecrets(data);
        seed.Store.Set("provider-key", ProviderKey);
        var key = seed.KeyPath;
        File.Move(key, key + ".away");
        var configuration = Configuration(
            temp.Path,
            new JsonObject { ["vector"] = false },
            new JsonObject
            {
                ["default"] = "referenced/m",
                ["providers"] = new JsonObject
                {
                    ["referenced"] = Provider(
                        "https://referenced.example.test/v1",
                        "${secret:provider-key}"
                    ),
                },
            }
        );
        Assert.Contains("provider-key", configuration.Capture().MissingSecrets["referenced"]);
        File.Move(key + ".away", key);
        var refreshed = configuration.Capture();
        Assert.False(refreshed.MissingSecrets.ContainsKey("referenced"));
        Assert.Equal(
            ProviderKey,
            refreshed.All.First(model => model.ProviderKey == "referenced").Token
        );
    }

    [Theory]
    [InlineData("synthetic-literal-client-secret")]
    [InlineData("${secret:oauth-client}")]
    public async Task OAuth_authorization_starts_with_literal_or_referenced_client_secrets(
        string secret
    )
    {
        await using var f = await OutboundMcpFixture.CreateAsync("https://localhost/preview");
        f.Mcp.Configuration.SecretLookup = name =>
            name == "oauth-client" ? "synthetic-resolved-client-secret" : null;
        await f.ConfigureAsync("http://127.0.0.1:9/mcp");
        await f.Mcp.SetAuthorizationAsync(
            "peer",
            new JsonObject
            {
                ["authentication"] = "oauth",
                ["scope"] = "read",
                ["clientId"] = "synthetic-client",
                ["clientSecret"] = secret,
            }
        );
        var error = await Assert.ThrowsAsync<McpOAuthException>(() =>
            f.Mcp.OAuth.BeginAsync("peer", f.Mcp.ResolvedAuthorizationServer("peer"), default)
        );
        // The settings comparison passes; the unreachable test server fails discovery later.
        Assert.NotEqual("changed", error.Code);
        var grants = Path.Combine(f.Data, "state", "mcp-oauth.json");
        if (File.Exists(grants))
            Assert.DoesNotContain("synthetic-resolved-client-secret", File.ReadAllText(grants));
    }

    [Fact]
    public async Task Answers_question_records_retry_notices_and_memory_writes_never_keep_known_values()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        new InstanceSecrets(data).Store.Set("provider-key", ProviderKey);
        var bodies = new List<string>();
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, captured) =>
            {
                lock (bodies)
                    bodies.Add(captured.Body);
                JsonObject item =
                    index == 0
                        ? new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = "ask",
                            ["name"] = "ask_user",
                            ["arguments"] = new JsonObject
                            {
                                ["questions"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["question"] = "Should I use " + ProviderKey + "?",
                                    }
                                ),
                            }.ToJsonString(),
                        }
                        : new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "output_text", ["text"] = "Done." }
                            ),
                        };
                await LoopbackResponsesServer.WriteResponseAsync(
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
                                    ["id"] = "r" + index,
                                    ["output"] = new JsonArray(item),
                                },
                            }.ToJsonString()
                            + "\n\n"
                    )
                );
            }
        );
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "memory"));
        var configuration = Configuration(
            temp.Path,
            new JsonObject { ["vector"] = false },
            new JsonObject
            {
                ["default"] = "synthetic/wire",
                ["providers"] = new JsonObject
                {
                    ["synthetic"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = peer.BaseUri.ToString(),
                        ["apiKey"] = "${secret:provider-key}",
                        ["models"] = new JsonArray("wire"),
                        ["contextLimit"] = 200000,
                    },
                },
            }
        );
        var options = new ResponsesClientOptions(
            peer.BaseUri,
            "wire",
            "synthetic/wire",
            "",
            "Base instructions.",
            1000
        );
        var manager = new SessionManager(
            data,
            work,
            options,
            new HostModels(configuration),
            Path.Combine(temp.Path, "skills")
        );
        try
        {
            await Exercise(manager, work, bodies);
        }
        finally
        {
            await manager.DisposeAsync();
        }
        var needle = Encoding.UTF8.GetBytes(ProviderKey);
        var files = Directory
            .EnumerateFiles(data, "*", SearchOption.AllDirectories)
            .Where(path => File.ReadAllBytes(path).AsSpan().IndexOf(needle) >= 0)
            .Select(path => Path.GetRelativePath(data, path))
            // The request journal records provider responses as received; this scripted
            // model wrote the value into its question.
            .Where(path => !path.StartsWith("state/llm-request-journal", StringComparison.Ordinal))
            .ToArray();
        Assert.Empty(files);
    }

    private static async Task Exercise(SessionManager manager, string work, List<string> bodies)
    {
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "answers", null, null);
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Set it up."));
        _ = owner.StartProcessing();
        await Until(() => SessionQuestions.Records(owner.Entry.Snapshot().Meta).Any());
        var id = SessionWait.Text(
            SessionQuestions.Records(owner.Entry.Snapshot().Meta).Single()["id"]
        )!;
        await manager.AnswerQuestionAsync(
            owner,
            id,
            new JsonObject
            {
                ["answers"] = new JsonArray(new JsonObject { ["text"] = "use " + ProviderKey }),
            }
        );
        _ = owner.StartProcessing();
        await Until(() =>
            owner
                .Entry.Snapshot()
                .History.Materialize()
                .Any(row => row.ToJsonString().Contains("Done.", StringComparison.Ordinal))
        );

        // A retry notice carries provider error text into history.
        var notice = new RetryNoticeState();
        await owner.Entry.SaveLane.CommitRetryNoticeAsync(
            notice,
            "Provider said: " + ProviderKey,
            new JsonObject()
        );
        Assert.DoesNotContain(ProviderKey, notice.Committed!.ToJsonString());

        // Memory writers refuse markers of masked values.
        var tools = new SessionToolExecutor(
            new WorkspaceTools(work),
            owner,
            manager,
            manager.ToolRegistry
        );
        tools.BeginTurn();
        var written = await tools.ExecuteAsync(
            new JsonObject
            {
                ["name"] = "write_memory",
                ["args"] = new JsonObject
                {
                    ["filePath"] = "notes/key.md",
                    ["content"] = "key: [[FW_SECRET:provider-key]]",
                },
            },
            default
        );
        Assert.Contains("secret marker", written!.ToJsonString());

        Assert.Equal(2, bodies.Count);
        Assert.DoesNotContain(ProviderKey, bodies[1]);
        var history = new JsonArray(
            owner
                .Entry.Snapshot()
                .History.Materialize()
                .Select(row => (JsonNode)row.DeepClone())
                .ToArray()
        ).ToJsonString();
        Assert.DoesNotContain(ProviderKey, history);
        Assert.Contains("[[FW_SECRET:provider-key]]", history);
        Assert.DoesNotContain(ProviderKey, owner.Entry.Snapshot().Meta.ToJsonString());
    }

    [Fact]
    public void Requests_do_not_count_reasoning_already_recorded_by_history_again()
    {
        using var temp = new TempDirectory();
        var secrets = new InstanceSecrets(Path.Combine(temp.Path, "data"));
        secrets.Store.Set("provider-key", ProviderKey);
        var history = new RequestHistory([
            new RequestHistory.Row(
                new JsonObject
                {
                    ["role"] = "model",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["thinking"] = "The key is " + ProviderKey,
                            ["thought"] = true,
                        }
                    ),
                }
            ),
        ]);
        for (var request = 0; request < 3; request++)
            _ = SecretRequestStage.Apply(secrets, "Instructions.", null, history, "main/s");
        Assert.Empty(secrets.Exposures.List());
    }

    [Fact]
    public void Node_token_path_errors_name_the_calling_tool()
    {
        var error = Assert.Throws<InvalidDataException>(() =>
            WorkspaceTools.PrivateNodeTokenPath("relative/token", "node_bootstrap_info")
        );
        Assert.StartsWith("node_bootstrap_info filePath", error.Message);
    }

    [Fact]
    public async Task Webhook_secrets_are_masked_and_both_set_config_refusals_apply()
    {
        const string hookToken = "synthetic-hook-verification-0001";
        await using var f = await ExternalChannelFixture.CreateAsync();
        f.Configuration.Secrets.Store.Set("provider-key", ProviderKey);
        var modelsPath = Path.Combine(f.Data, "state", "models.yaml");
        var models = JsonNode.Parse(File.ReadAllText(modelsPath))!.AsObject();
        models["providers"]!["inherits"] = Provider(null, "${secret:provider-key}");
        File.WriteAllText(modelsPath, models.ToJsonString());
        var baseRaw = f.Configuration.ReadCurrentAppRaw().TrimEnd();
        string Config(string token, string extra = "") =>
            baseRaw
            + "\n"
            + extra
            + "access:\n  identities:\n    hook:\n      token: '"
            + token
            + "'\n      surfaces:\n        webhook: {session: main, verify: bearer}\n";
        Assert.True(
            SessionCatalog.Flag((await f.Configuration.SaveAppAsync(Config(hookToken)))["saved"])
        );
        // The verification secret is an access identity token: masked, never a reference.
        Assert.Equal(
            "got [[FW_SECRET:access.hook]]",
            f.Configuration.Secrets.Redact("got " + hookToken, "test")
        );
        var saved = f.Configuration.ReadCurrentAppRaw();
        await Assert.ThrowsAnyAsync<InvalidDataException>(() =>
            f.Configuration.SaveAppAsync(Config("${secret:provider-key}"))
        );
        Assert.Equal(saved, f.Configuration.ReadCurrentAppRaw());

        var candidate = Path.Combine(f.Work, "candidate.yaml");
        async Task<string?> SetConfig(string raw)
        {
            await File.WriteAllTextAsync(candidate, raw);
            var result = await f.ToolAsync(
                "set_config",
                new JsonObject { ["target"] = "config", ["filePath"] = candidate }
            );
            Assert.Equal(saved, f.Configuration.ReadCurrentAppRaw());
            return SessionWait.Text(result?["error"]?["message"]);
        }
        // Each refusal applies on its own and neither lets the other's change through.
        Assert.Contains(
            "llm.openaiBaseUrl",
            await SetConfig(
                Config(hookToken, "llm:\n  openaiBaseUrl: https://collector.example.test/v1\n")
            )
        );
        Assert.Equal(
            ModelConfiguration.WebhooksLockedError,
            await SetConfig(Config("synthetic-hook-rotated-0002"))
        );
        Assert.Contains(
            "llm.openaiBaseUrl",
            await SetConfig(
                Config(
                    "synthetic-hook-rotated-0002",
                    "llm:\n  openaiBaseUrl: https://collector.example.test/v1\n"
                )
            )
        );
        Assert.Contains("secret marker", await SetConfig(Config("[[FW_SECRET:access.hook]]")));
        // A reference in an identity token is invalid configuration, reported like any other.
        Assert.StartsWith(
            "Invalid config YAML candidate.",
            await SetConfig(Config("${secret:provider-key}"))
        );
    }
}
