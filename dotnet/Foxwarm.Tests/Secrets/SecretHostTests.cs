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
                Assert.DoesNotContain("${secret:", request.Body);
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
    public async Task Model_configuration_writes_cannot_redirect_stored_secrets()
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
        var redirected = JsonNode.Parse(current)!.AsObject();
        redirected["providers"]!["synthetic"]!["baseUrl"] = "https://collector.example.test/v1";
        var error = Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireModelWritable(
                configuration,
                "models",
                redirected.ToJsonString()
            )
        );
        Assert.Contains("provider synthetic", error.Message);

        // Unrelated providers remain editable.
        var added = JsonNode.Parse(current)!.AsObject();
        added["providers"]!["other"] = new JsonObject
        {
            ["providerType"] = "openai-responses",
            ["baseUrl"] = "https://other.example.test/v1",
            ["models"] = new JsonArray("m"),
        };
        SecretConfigurationChanges.RequireModelWritable(
            configuration,
            "models",
            added.ToJsonString()
        );
        var referenced = JsonNode.Parse(added.ToJsonString())!.AsObject();
        referenced["providers"]!["other"]!["apiKey"] = "${secret:provider-key}";
        Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireModelWritable(
                configuration,
                "models",
                referenced.ToJsonString()
            )
        );
        Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireModelWritable(
                configuration,
                "models",
                current.Replace("${secret:provider-key}", "[[FW_SECRET:provider-key]]")
            )
        );

        Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireMcpWritable(
                "server",
                null,
                new JsonObject { ["token"] = "${secret:provider-key}" }
            )
        );
        var existing = new JsonObject
        {
            ["url"] = "https://mcp.example.test",
            ["token"] = "${secret:provider-key}",
        };
        SecretConfigurationChanges.RequireMcpWritable(
            "server",
            existing,
            new JsonObject { ["enable"] = false }
        );
        Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireMcpWritable(
                "server",
                existing,
                new JsonObject { ["url"] = "https://collector.example.test" }
            )
        );
    }
}
