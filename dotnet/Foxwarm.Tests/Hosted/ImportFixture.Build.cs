using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// A synthetic file-mode installation that fills every store the import reads, written by the
/// file stores themselves: Sessions with a completed turn (authority, catalog, Archive, journal
/// and usage ledger) through a <see cref="SessionManager"/> against a scripted provider, Tasks
/// with a parent and a note, a timer, a ToolScript run, an Activity direct effect, secrets, an
/// OAuth grant, the text-redaction cache, Node tokens and registry, configuration documents
/// with comments, deployment-only and refused settings, and an image and an artifact blob.
/// </summary>
internal static partial class ImportFixture
{
    internal const string SecretName = "provider-token";
    internal const string SecretValue = "synthetic-import-secret-value-0001";
    internal const string RedactedOriginal = "synthetic private value for redaction";
    internal static readonly byte[] ImageContent = Encoding.UTF8.GetBytes("synthetic image bytes");
    internal static readonly byte[] ArtifactContent = Encoding.UTF8.GetBytes("{\"title\":\"synthetic artifact\"}");

    internal const string ConfigYaml = """
        # Synthetic installation configuration.
        sessionAutoTitle: false

        # The bot section mixes tenant and deployment settings.
        bot:
          name: import-fixture
          # Listener port: a deployment setting.
          httpPort: 3999
          enableTUI: false
        # Speech recognition is configured per deployment.
        asrService:
          enabled: false
          url: http://127.0.0.1:9/
        vector: false
        # Kept for the tenant.
        llm:
          maxOutput: 4096 # trailing comment
        """;

    internal sealed record Built(string DataRoot, string SessionId, string ChildSessionId, string ImageKey, string ArtifactKey);

    internal static async Task<Built> BuildAsync(string root)
    {
        var data = Path.Combine(root, "data");
        var work = Path.Combine(root, "work");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        Directory.CreateDirectory(Path.Combine(work, "memory"));
        // The lock a Main that ran its startup migrations leaves behind.
        InstallationLock.Acquire(data).Dispose();

        await using var peer = new ScriptedResponsesSequenceServer(
            1,
            async (_, stream, _) =>
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
                                    ["id"] = "synthetic-reply",
                                    ["output"] = new JsonArray(
                                        new JsonObject
                                        {
                                            ["type"] = "message",
                                            ["role"] = "assistant",
                                            ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = "Imported reply." }),
                                        }
                                    ),
                                    ["usage"] = new JsonObject { ["input_tokens"] = 11, ["output_tokens"] = 3 },
                                },
                            }.ToJsonString()
                            + "\n\n"
                    )
                )
        );
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), "vector: false\n");
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "models.yaml"),
            new JsonObject
            {
                ["default"] = "synthetic/wire",
                ["providers"] = new JsonObject
                {
                    ["synthetic"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = peer.BaseUri.ToString(),
                        ["models"] = new JsonArray("wire"),
                        ["contextLimit"] = 200000,
                        ["apiKey"] = "${secret:" + SecretName + "}",
                    },
                },
            }.ToJsonString()
        );
        var secrets = new InstanceSecrets(data);
        secrets.Store.Set(SecretName, SecretValue);
        secrets.Dispose();

        string sessionId;
        string childId;
        var models = new HostModels(new ModelConfiguration(HostPaths.ForDataRoot(data, root, environment: _ => null)));
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "synthetic/wire", "", "Base instructions.", 1000);
        await using (var manager = new SessionManager(data, work, options, models, Path.Combine(root, "skills")))
        {
            await manager.LoadMainHostAsync();
            var owner = await manager.CreateNamedAsync("main", "imported", null, null);
            sessionId = owner.Id;
            var child = await manager.CreateNamedAsync("main", "second", null, null);
            childId = child.Id;
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Hello from the file installation."));
            _ = owner.StartProcessing();
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(30);
            while (!owner.Entry.Snapshot().History.Materialize().Any(row => row.ToJsonString().Contains("Imported reply.", StringComparison.Ordinal)))
            {
                if (DateTime.UtcNow > deadline)
                    throw new TimeoutException("The fixture turn didn't finish.");
                await Task.Delay(20);
            }
            await manager.Storage.Archive.RecordDirectEffectAsync(
                ArchiveToolEffects.FromDirectCall(sessionId, "main", "user", 1_700_000_000_000, null, "add_secret", null, new JsonObject(), "synthetic direct effect", null, null)
            );
        }

        using (var tasks = new TaskStore(data, id => id, _ => []))
        {
            var parent = tasks.Execute(new JsonObject { ["action"] = "create", ["title"] = "Parent task", ["description"] = "Imported." }, sessionId);
            var parentId = parent.Payload["taskId"]?.GetValue<string>() ?? parent.Payload["task"]!["id"]!.GetValue<string>();
            var childTask = tasks.Execute(new JsonObject { ["action"] = "create", ["title"] = "Child task", ["parentTaskId"] = parentId }, sessionId);
            var childTaskId = childTask.Payload["taskId"]?.GetValue<string>() ?? childTask.Payload["task"]!["id"]!.GetValue<string>();
            tasks.Execute(new JsonObject { ["action"] = "update", ["taskId"] = childTaskId, ["note"] = "A progress note." }, sessionId);
        }

        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "timers.json"),
            new JsonObject
            {
                ["timers"] = new JsonArray(new JsonObject
                {
                    ["id"] = "fixture-timer",
                    ["sessionId"] = sessionId,
                    ["message"] = "timer message",
                    ["createdAt"] = 1,
                    ["at"] = 4_000_000_000_000,
                }),
            }.ToJsonString()
        );
        await new Foxwarm.ToolScript.ToolScriptRunStore(data).WriteAsync(
            new JsonObject
            {
                ["runId"] = "tsr_1700000000000_0123abcd",
                ["mode"] = "foreground",
                ["status"] = "completed",
                ["ownerSessionId"] = sessionId,
                ["agentName"] = "main",
                ["stdout"] = "fixture\n",
                ["createdAt"] = 1_700_000_000_000,
                ["updatedAt"] = 1_700_000_000_001,
            },
            CancellationToken.None
        );
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "mcp-oauth.json"),
            new JsonObject
            {
                ["version"] = 1,
                ["servers"] = new JsonObject
                {
                    ["remote"] = new JsonObject { ["accessToken"] = "synthetic-oauth-access-token", ["refreshToken"] = "synthetic-oauth-refresh-token" },
                },
            }.ToJsonString()
        );

        // The redaction cache: a known original under the placeholder the installation key gives it.
        using (var redacting = new InstanceSecrets(data))
        {
            redacting.SetTextRedactionKnownLabels(TextRedactionKnownLabels.All);
            var redactor = redacting.TextRedactor();
            var placeholder = redactor.Placeholder(Encoding.UTF8.GetBytes(RedactedOriginal));
            if (!redactor.TryRegister(placeholder, RedactedOriginal, ["PRIVATE"]))
                throw new InvalidOperationException("The fixture couldn't register a redaction original.");
        }

        var credentials = new FileInstanceCredentials(data);
        foreach (var name in Enum.GetValues<InstanceCredentialName>())
            credentials.ReadOrCreate(name, () => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "nodes.json"),
            new JsonObject
            {
                ["approvedNodes"] = new JsonObject
                {
                    ["fixture-node"] = new JsonObject
                    {
                        ["nodeId"] = "fixture-node",
                        ["nodeType"] = "cli-node",
                        ["requestedName"] = "fixture-node",
                        ["displayName"] = "fixture-node",
                        ["tokenHash"] = Convert.ToHexStringLower(SHA256.HashData("fixture-node-token"u8)),
                        ["createdAt"] = 1_700_000_000_000,
                        ["updatedAt"] = 1_700_000_000_000,
                    },
                },
                ["pendingNodes"] = new JsonObject(),
            }.ToJsonString()
        );
        await File.WriteAllTextAsync(Path.Combine(data, "state", "config.yaml"), ConfigYaml);
        await File.WriteAllTextAsync(Path.Combine(data, "state", "webui.json"), "{\n  \"instanceName\": \"fixture\"\n}\n");
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "mcp.json"),
            new JsonObject
            {
                ["servers"] = new JsonObject
                {
                    ["remote"] = new JsonObject { ["transport"] = "streamable-http", ["url"] = "https://example.invalid/mcp" },
                    ["local"] = new JsonObject { ["transport"] = "stdio", ["command"] = "true" },
                },
            }.ToJsonString()
        );

        var imageKey = Convert.ToHexStringLower(SHA256.HashData(ImageContent));
        await new Foxwarm.Images.ImageBlobFiles(data).CreateAsync(imageKey, ImageContent, keepExisting: false, CancellationToken.None);
        const string artifactKey = "art_fixture/1.json";
        await new Foxwarm.Artifacts.ArtifactBlobFiles(Path.Combine(data, "state", "artifacts")).CreateAsync(artifactKey, ArtifactContent, keepExisting: false, CancellationToken.None);
        var docs = Directory.CreateDirectory(Path.Combine(data, "agents", "main", "docs"));
        await File.WriteAllTextAsync(Path.Combine(docs.FullName, "notes.md"), "Notes from the source installation.\n");
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "running-exec.json"),
            new JsonObject { ["execs"] = new JsonArray(new JsonObject { ["execId"] = "fixture-exec" }) }.ToJsonString()
        );
        // Main's connections close when it exits; the fixture's pooled ones close here.
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        return new Built(data, sessionId, childId, imageKey, artifactKey);
    }

    /// <summary>A copy of <paramref name="source"/>'s data root, for a case that changes it.</summary>
    internal static string Copy(string source, string target)
    {
        foreach (var directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            Directory.CreateDirectory(Path.Combine(target, Path.GetRelativePath(source, directory)));
        foreach (var file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
        {
            var destination = Path.Combine(target, Path.GetRelativePath(source, file));
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            File.Copy(file, destination);
        }
        return target;
    }
}
