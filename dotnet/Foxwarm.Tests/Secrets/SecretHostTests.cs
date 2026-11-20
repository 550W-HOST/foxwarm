using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class SecretHostTests
{
    private const string ProviderKey = "sk-synthetic-provider-key-0001";
    private const string FileValue = "synthetic-file-token-value-0002";

    private static string Event(JsonObject response) =>
        "data: "
        + new JsonObject { ["type"] = "response.completed", ["response"] = response }.ToJsonString()
        + "\n\n";

    private static JsonObject Reply(JsonObject output) =>
        new() { ["id"] = "synthetic-reply", ["output"] = new JsonArray(output) };

    private static async Task Until(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(30);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Timed out waiting for the turn.");
            await Task.Delay(20);
        }
    }

    private static async Task<SessionManager> CreateManager(
        string root,
        Uri uri,
        JsonObject provider
    )
    {
        var data = Path.Combine(root, "data");
        var work = Path.Combine(root, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(Path.Combine(work, "memory"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "config.yaml"),
            new JsonObject { ["vector"] = false }.ToJsonString()
        );
        provider["providerType"] = "openai-responses";
        provider["baseUrl"] = uri.ToString();
        provider["models"] = new JsonArray("wire");
        provider["contextLimit"] = 200000;
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            new JsonObject
            {
                ["default"] = "synthetic/wire",
                ["providers"] = new JsonObject { ["synthetic"] = provider },
            }.ToJsonString()
        );
        var models = new HostModels(
            new ModelConfiguration(HostPaths.ForDataRoot(data, root, environment: _ => null))
        );
        var options = new ResponsesClientOptions(
            uri,
            "wire",
            "synthetic/wire",
            "",
            "Base instructions.",
            1000
        );
        var manager = new SessionManager(data, work, options, models, Path.Combine(root, "skills"));
        await manager.LoadMainHostAsync();
        return manager;
    }

    [Fact]
    public async Task Provider_references_resolve_and_known_values_never_reach_history_or_requests()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        // Setup stores values before Main uses them; a separate owner shares the key file.
        var seed = new InstanceSecrets(data);
        seed.Store.Set("provider-key", ProviderKey);
        seed.Store.Set("file-token", FileValue);
        string? filePath = null;
        var requests = new List<CapturedHttpRequest>();
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, captured) =>
            {
                lock (requests)
                    requests.Add(captured);
                var output =
                    index == 0
                        ? new JsonObject
                        {
                            ["type"] = "function_call",
                            ["call_id"] = "read-credentials",
                            ["name"] = "read",
                            ["arguments"] = new JsonObject
                            {
                                ["filePath"] = filePath,
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
                    Encoding.UTF8.GetBytes(Event(Reply(output)))
                );
            }
        );
        await using var manager = await CreateManager(
            temp.Path,
            peer.BaseUri,
            new JsonObject { ["apiKey"] = "${secret:provider-key}" }
        );
        var owner = await manager.CreateNamedAsync("main", "secrets", null, null);
        filePath = Path.Combine(manager.AgentDirectory("main"), "credentials.txt");
        await File.WriteAllTextAsync(filePath, "token=" + FileValue);

        await owner.Registry.Ingress.EnqueueAsync(
            owner.Id,
            QueueItem.UserText("My provider key is " + ProviderKey)
        );
        _ = owner.StartProcessing();
        await Until(() =>
            owner
                .Entry.Snapshot()
                .History.Materialize()
                .Any(row => row.ToJsonString().Contains("Done.", StringComparison.Ordinal))
        );

        Assert.Equal(2, requests.Count);
        Assert.All(
            requests,
            request => Assert.Equal("Bearer " + ProviderKey, request.Headers["Authorization"])
        );
        Assert.All(
            requests,
            request =>
            {
                Assert.DoesNotContain(ProviderKey, request.Body);
                Assert.DoesNotContain(FileValue, request.Body);
                // Tool descriptions may show the reference syntax; these references never appear.
                Assert.DoesNotContain("${secret:provider-key}", request.Body);
                Assert.DoesNotContain("${secret:file-token}", request.Body);
            }
        );
        Assert.Contains("[[FW_SECRET:provider-key]]", requests[0].Body);
        Assert.Contains("[[FW_SECRET:file-token]]", requests[1].Body);

        var history = new JsonArray(
            owner
                .Entry.Snapshot()
                .History.Materialize()
                .Select(row => (JsonNode)row.DeepClone())
                .ToArray()
        ).ToJsonString();
        Assert.Contains("[[FW_SECRET:provider-key]]", history);
        Assert.Contains("[[FW_SECRET:file-token]]", history);
        Assert.DoesNotContain(ProviderKey, history);
        Assert.DoesNotContain(FileValue, history);

        var secrets = manager.Secrets!;
        Assert.Contains(
            secrets.Exposures.List(),
            item => item is { Label: "provider-key", LastSessionId: not null }
        );
        Assert.Contains(secrets.Exposures.List(), item => item.Label == "file-token");
    }

    [Fact]
    public async Task A_missing_provider_secret_fails_the_turn_without_contacting_the_provider()
    {
        using var temp = new TempDirectory();
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            (_, _, _) => throw new InvalidOperationException("The provider must not be contacted.")
        );
        await using var manager = await CreateManager(
            temp.Path,
            peer.BaseUri,
            new JsonObject { ["apiKey"] = "${secret:absent-key}" }
        );
        var owner = await manager.CreateNamedAsync("main", "missing", null, null);
        var failed = new TaskCompletionSource<string>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        owner.Registry.OnTurnFailure = (error, _) =>
        {
            failed.TrySetResult(error.Message);
            return Task.CompletedTask;
        };
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Hello."));
        _ = owner.StartProcessing();
        var failure = await failed.Task.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(0, peer.RequestCount);
        Assert.Contains("absent-key", failure);
        Assert.Contains("Setup > Secrets", failure);
    }

    [Fact]
    public async Task Configuration_changes_report_the_secrets_they_send_somewhere_new()
    {
        using var temp = new TempDirectory();
        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            (_, _, _) => Task.CompletedTask
        );
        await using var manager = await CreateManager(
            temp.Path,
            peer.BaseUri,
            new JsonObject { ["apiKey"] = "${secret:provider-key}" }
        );
        var configuration = manager.Models.ConfigurationOwner!;
        var current = await File.ReadAllTextAsync(configuration.ActivePath);
        IReadOnlyList<string> Facts(Action<JsonObject> edit)
        {
            var candidate = JsonNode.Parse(current)!.AsObject();
            edit(candidate);
            return SecretConfigurationChanges.ForConfiguration(
                configuration,
                "models",
                candidate.ToJsonString()
            );
        }
        JsonObject Synthetic(JsonObject root) => root["providers"]!["synthetic"]!.AsObject();

        Assert.Equal(
            ["provider-key"],
            Facts(root => Synthetic(root)["baseUrl"] = "https://collector.example.test/v1")
        );
        Assert.Equal(
            ["provider-key"],
            Facts(root => Synthetic(root)["providerType"] = "anthropic")
        );
        // Model lists and limits live in the same provider entry but send the key nowhere new.
        Assert.Empty(Facts(root => Synthetic(root)["models"] = new JsonArray("wire", "other")));
        Assert.Empty(Facts(root => Synthetic(root)["contextLimit"] = 100000));
        Assert.Empty(Facts(root => root["providers"]!.AsObject().Remove("synthetic")));
        // Another provider using the same key at the same destination is not new either.
        Assert.Empty(Facts(root => root["providers"]!["copy"] = Synthetic(root).DeepClone()));
        Assert.Empty(
            Facts(root =>
                root["providers"]!["other"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = "https://other.example.test/v1",
                    ["models"] = new JsonArray("m"),
                }
            )
        );
        Assert.Equal(
            ["provider-key"],
            Facts(root =>
                root["providers"]!["other"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = "https://other.example.test/v1",
                    ["apiKey"] = "${secret:provider-key}",
                    ["models"] = new JsonArray("m"),
                }
            )
        );
        Assert.Equal(
            ["provider-key"],
            Facts(root =>
                Synthetic(root)["extraHeaders"] = new JsonObject
                {
                    ["X-Forward"] = "${secret:provider-key}",
                }
            )
        );

        var servers = new JsonObject
        {
            ["server"] = new JsonObject
            {
                ["url"] = "https://mcp.example.test",
                ["token"] = "${secret:provider-key}",
            },
            ["local"] = new JsonObject
            {
                ["transport"] = "stdio",
                ["command"] = "server",
                ["env"] = new JsonObject { ["API_TOKEN"] = "${secret:local-key}" },
            },
        };
        IReadOnlyList<string> Mcp(string name, string patch) =>
            SecretConfigurationChanges.ForMcpServer(
                servers,
                name,
                JsonNode.Parse(patch)!.AsObject()
            );
        Assert.Equal(
            ["provider-key"],
            Mcp(
                "added",
                """{"url":"https://other.example.test","token":"${secret:provider-key}"}"""
            )
        );
        Assert.Equal(
            ["provider-key"],
            Mcp("server", """{"headers":{"X-Key":"${secret:provider-key}"}}""")
        );
        Assert.Equal(
            ["provider-key"],
            Mcp("server", """{"url":"https://collector.example.test"}""")
        );
        Assert.Equal(["provider-key"], Mcp("server", """{"transport":"sse"}"""));
        Assert.Equal(["local-key"], Mcp("local", """{"command":"other"}"""));
        Assert.Equal(["local-key"], Mcp("local", """{"args":["--forward"]}"""));
        Assert.Equal(
            ["local-key"],
            Mcp("local", """{"env":{"API_TOKEN":"${secret:local-key}","HOME":"/x"}}""")
        );
        foreach (
            var patch in new[]
            {
                """{"enable":false}""",
                """{"description":"Renamed"}""",
                """{"timeoutSeconds":30}""",
                """{"token":"literal-token"}""",
                """{"stderr":"ignore"}""",
            }
        )
            Assert.Empty(Mcp(patch.Contains("stderr") ? "local" : "server", patch));
        Assert.Empty(Mcp("added", """{"url":"https://other.example.test"}"""));
        // A second server with the same URL and token sends it nowhere new.
        Assert.Empty(
            Mcp("copy", """{"url":"https://mcp.example.test","token":"${secret:provider-key}"}""")
        );
    }
}
