using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    private const string DetectorKey = "synthetic-detector-credential-0001";
    private const string StoredToken = "synthetic-stored-token-value-0002";

    // An installed host: models.yaml, the instance key and the secret store under one data root.
    private static async Task<SessionManager> InstalledManager(
        string root,
        Uri provider,
        JsonObject defaults
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
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            new JsonObject
            {
                ["default"] = "p/m",
                ["defaults"] = defaults,
                ["providers"] = new JsonObject
                {
                    ["p"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = provider.ToString(),
                        ["models"] = new JsonArray("m"),
                    },
                },
            }.ToJsonString()
        );
        var models = new HostModels(
            new ModelConfiguration(HostPaths.ForDataRoot(data, root, environment: _ => null))
        );
        var manager = new SessionManager(
            data,
            work,
            new(provider, "unused", "unused", "", "", 100),
            models,
            Path.Combine(root, "skills")
        );
        await manager.LoadMainHostAsync();
        return manager;
    }

    [Fact]
    public async Task Installed_requests_share_keys_keep_secret_markers_and_use_the_referenced_detector_key()
    {
        const string secret = "shared-private-value";
        const string marker = "[[FW_SECRET:user-token]]";
        // The detected range covers the stored token: detection sees only its marker.
        await using var detector = await TextDetectionPeer.StartAsync(secret, "token " + marker);
        var keys = new List<string>();
        await using var peer = new ScriptedResponsesSequenceServer(
            2,
            async (_, stream, request) =>
            {
                var body = JsonNode.Parse(request.Body)!;
                var key = body["input"]![0]!["content"]![0]!["text"]!.GetValue<string>();
                keys.Add(key);
                var response = new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = new JsonObject
                    {
                        ["output"] = new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = key }
                                ),
                            }
                        ),
                    },
                };
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes("data: " + response.ToJsonString() + "\n\n")
                );
            }
        );
        using var temp = new TempDirectory();
        var seed = new InstanceSecrets(Path.Combine(temp.Path, "data"));
        seed.Store.Set("detector-key", DetectorKey);
        seed.Store.Set("user-token", StoredToken);
        seed.Dispose();
        await using var manager = await InstalledManager(
            temp.Path,
            peer.BaseUri,
            new JsonObject
            {
                ["textRedaction"] = new JsonObject
                {
                    ["enabled"] = true,
                    ["endpoint"] = detector.Endpoint.ToString(),
                    ["apiKey"] = "${secret:detector-key}",
                },
            }
        );
        var input = secret + " and token " + StoredToken;
        foreach (var name in new[] { "first", "second" })
        {
            var owner = await manager.CreateNamedAsync("main", name, null, null);
            var result = await manager.RequestToolScriptModelAsync(
                owner,
                input,
                "p/m",
                new Foxwarm.ToolScript.ToolScriptDataBudget(),
                default
            );
            // Placeholders restore; the irreversible secret marker stays as it is.
            Assert.Equal(secret + " and token " + marker, SessionWait.Text(result["text"]));
        }
        Assert.StartsWith(TextRedactor.Prefix, keys[0]);
        Assert.Equal(keys[0], keys[1]);
        Assert.Contains(marker, keys[0]);
        Assert.DoesNotContain("token " + marker, keys[0]);
        Assert.DoesNotContain(secret, keys[0]);
        Assert.DoesNotContain(StoredToken, keys[0]);
        var detected = Assert.Single(detector.Texts);
        Assert.Equal(secret + " and token " + marker, detected);
        Assert.Equal("Bearer " + DetectorKey, detector.Authorization);
        Assert.True(manager.Secrets!.Redactor.IsKnownValue(DetectorKey));
    }

    [Fact]
    public async Task Detector_key_references_fail_only_providers_that_send_them()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        const string literal = "synthetic-literal-detector-key-0003";
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = $$$"""
                defaults:
                  textRedaction: {endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:absent-key}'}
                providers:
                  on: {baseUrl: 'http://127.0.0.1:2', textRedaction: true}
                  off: {baseUrl: 'http://127.0.0.1:2'}
                  own: {baseUrl: 'http://127.0.0.1:2', textRedaction: {enabled: true, apiKey: '{{{literal}}}'}}
                  mixed:
                    baseUrl: http://127.0.0.1:2
                    models: [plain, {id: protected, textRedaction: true}]
                  leaf:
                    baseUrl: http://127.0.0.1:2
                    models: [{id: m, textRedaction: {enabled: true, apiKey: '${secret:leaf-key}'}}]
                """,
            }
        );
        var catalog = configuration.Capture();
        Assert.Equal(new[] { "absent-key" }, catalog.MissingSecrets["on"]);
        Assert.Equal(new[] { "absent-key" }, catalog.MissingSecrets["mixed"]);
        Assert.Equal(new[] { "leaf-key" }, catalog.MissingSecrets["leaf"]);
        Assert.False(catalog.MissingSecrets.ContainsKey("off"));
        Assert.False(catalog.MissingSecrets.ContainsKey("own"));
        Assert.Throws<ModelPreparationException>(() =>
            catalog.RequireSecrets(catalog.Resolve("on"))
        );
        Assert.True(configuration.Secrets.Redactor.IsKnownValue(literal));
        Assert.Equal(
            literal,
            TextRedactionOptions
                .FromResolved(catalog.Resolve("own").Configuration["textRedaction"]!.AsObject())!
                .ApiKey
        );
        configuration.Secrets.Store.Set("absent-key", DetectorKey);
        catalog = configuration.Capture();
        Assert.False(catalog.MissingSecrets.ContainsKey("on"));
        Assert.Equal(
            DetectorKey,
            TextRedactionOptions
                .FromResolved(catalog.Resolve("on").Configuration["textRedaction"]!.AsObject())!
                .ApiKey
        );
        Assert.Contains(
            configuration.SecretUsages(new JsonObject())["absent-key"],
            usage => SessionWait.Text(usage["id"]) == "models.defaults.textRedaction.apiKey"
        );

        // References belong only in apiKey; model-initiated writes cannot redirect them.
        Assert.Throws<InvalidDataException>(() =>
            HostModels.Parse(
                JsonNode
                    .Parse(
                        """{"providers":{"p":{"textRedaction":{"endpoint":"${secret:absent-key}"}}}}"""
                    )!
                    .AsObject(),
                new()
            )
        );
        var installed = await File.ReadAllTextAsync(configuration.ActivePath);
        var redirected = installed.Replace(
            "textRedaction: true",
            "textRedaction: {enabled: true, endpoint: 'http://127.0.0.1:9/classify'}",
            StringComparison.Ordinal
        );
        Assert.NotEqual(installed, redirected);
        Assert.Contains("off: {baseUrl: 'http://127.0.0.1:2'}", installed);
        Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireModelWritable(configuration, "models", redirected)
        );
        SecretConfigurationChanges.RequireModelWritable(
            configuration,
            "models",
            installed.Replace(
                "off: {baseUrl: 'http://127.0.0.1:2'}",
                "off: {baseUrl: 'http://127.0.0.1:3'}",
                StringComparison.Ordinal
            )
        );
    }
}
