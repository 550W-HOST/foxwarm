using System.Net.Sockets;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Tests.Hosted;

// The hosted capability profile in the hosted runtime (HostedEntry.BuildRuntimeAsync): a turn
// that uses the Agent's memory (in the Agent store) and Node tools without a master Node, and
// the scratch guard.
public sealed partial class HostedStartupTests
{
    // What a replica may keep in FOXWARM_SCRATCH_DIR: its logs, the Provider image cache, upload
    // staging and `.temp`. Anything else would be durable state on the container's filesystem.
    private static readonly string[] ScratchAllowed =
    [
        "state/logs",
        "state/provider-image-cache",
        "foxwarm-uploads",
        ".temp",
    ];

    internal static IReadOnlyList<string> ScratchOutsideAllowlist(string scratch)
    {
        if (!Directory.Exists(scratch))
            return [];
        var outside = new List<string>();
        foreach (var entry in Directory.EnumerateFileSystemEntries(scratch, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(scratch, entry).Replace(Path.DirectorySeparatorChar, '/');
            var allowed = ScratchAllowed.Any(root =>
                relative == root
                || relative.StartsWith(root + "/", StringComparison.Ordinal)
                // The parents of an allowed directory.
                || root.StartsWith(relative + "/", StringComparison.Ordinal) && Directory.Exists(entry)
            );
            if (!allowed)
                outside.Add(relative);
        }
        return outside;
    }

    [Fact]
    public void TheScratchGuardNamesEverythingOutsideTheAllowlist()
    {
        using var temp = new TempDirectory();
        foreach (var file in new[] { "state/logs/foxwarm.log", "state/provider-image-cache/a", ".temp/x/y", "foxwarm-uploads/u" })
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(temp.Path, file))!);
            File.WriteAllText(Path.Combine(temp.Path, file), "");
        }
        Assert.Empty(ScratchOutsideAllowlist(temp.Path));
        Directory.CreateDirectory(Path.Combine(temp.Path, "state", "db"));
        File.WriteAllText(Path.Combine(temp.Path, "state", "catalog.sqlite"), "");
        File.WriteAllText(Path.Combine(temp.Path, "agents.json"), "");
        Assert.Equal(
            ["agents.json", "state/catalog.sqlite", "state/db"],
            ScratchOutsideAllowlist(temp.Path).Order(StringComparer.Ordinal)
        );
    }

    private static Task RespondAsync(NetworkStream stream, JsonArray output) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            200,
            "text/event-stream",
            Encoding.UTF8.GetBytes(
                "data: "
                    + new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject { ["output"] = output },
                    }.ToJsonString()
                    + "\n\n"
            )
        );

    private static JsonObject FunctionCall(string id, string name, JsonObject args) =>
        new()
        {
            ["type"] = "function_call",
            ["call_id"] = id,
            ["name"] = name,
            ["arguments"] = args.ToJsonString(),
        };

    [Fact]
    public async Task AHostedTurnUsesMemoryWithoutMasterAndLeavesNothingDurableInScratch()
    {
        var server = await PostgresServer.SharedAsync();
        await using var database = await server.CreateDatabaseAsync();
        using var temp = new TempDirectory();
        var files = HostedFiles.Create(temp.Path);
        // Stores this build lacks still come from files; they stay out of the scratch directory.
        var fileStores = Path.Combine(temp.Path, "file-stores");
        await using var model = new ScriptedResponsesSequenceServer(
            2,
            async (index, stream, _) =>
                await RespondAsync(
                    stream,
                    index == 0
                        ? new JsonArray(
                            FunctionCall("nodes", "ctl", new JsonObject { ["command"] = "node list" }),
                            FunctionCall(
                                "note",
                                "write_memory",
                                new JsonObject { ["filePath"] = "NOTES.md", ["content"] = "kept" }
                            ),
                            FunctionCall("shell", "exec", new JsonObject { ["command"] = "touch scratch-marker" })
                        )
                        : new JsonArray(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = "done" }
                                ),
                            }
                        )
                )
        );
        IStorageContext? storage = null;
        var replica = StartHosted(database.OpenApp(), files, built => storage = built, fileStores);
        await WaitUntilAsync(
            () => replica.Inner.Health.Role == ReplicaRole.Owner && replica.Inner.Health.RuntimeStarted,
            TimeSpan.FromSeconds(60),
            "the hosted runtime serves"
        );
        using var client = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            BaseAddress = new Uri($"http://127.0.0.1:{replica.PublicPort}"),
            Timeout = TimeSpan.FromSeconds(20),
        };
        client.DefaultRequestHeaders.Authorization = new(
            "Bearer",
            storage!.Credentials.Read(InstanceCredentialName.HttpToken)
        );
        var models =
            $"default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: {model.BaseUri}\n    models: [wire]\n";
        var saved = await client.PostAsJsonAsync("api/setup/models", new { yaml = models });
        Assert.True(saved.IsSuccessStatusCode, await saved.Content.ReadAsStringAsync());

        // No Main-local terminals or Code: the terminal registry is empty and unsupported, and
        // the Code routes don't exist.
        var terminals = await client.GetFromJsonAsync<JsonNode>("api/terminals");
        Assert.False(terminals!["supported"]!.GetValue<bool>());
        Assert.Empty(terminals["terminals"]!.AsArray());
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await client.GetAsync("api/vscode-web/fs/workspace-roots")).StatusCode
        );

        var created = await client.PostAsJsonAsync("api/sessions", new { agentId = "main", sessionId = "turn" });
        Assert.True(created.IsSuccessStatusCode, await created.Content.ReadAsStringAsync());
        var sent = await client.PostAsJsonAsync("api/sessions/turn/message", new { text = "Take a note." });
        Assert.Equal(HttpStatusCode.Accepted, sent.StatusCode);
        await model.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(60));
        JsonArray? results = null;
        await WaitUntilAsync(
            () =>
            {
                var history = JsonNode.Parse(client.GetStringAsync("api/sessions/turn/history").GetAwaiter().GetResult())!;
                results = new JsonArray(
                    history["messages"]!
                        .AsArray()
                        .OfType<JsonObject>()
                        .Where(message => SessionWait.Text(message["role"]) == "tool")
                        .Select(message => message.DeepClone())
                        .ToArray()
                );
                return history.ToJsonString().Contains("\"done\"", StringComparison.Ordinal);
            },
            TimeSpan.FromSeconds(30),
            "the turn completes"
        );
        var tools = results!.ToJsonString();
        // The history JSON escapes the copy's backticks and angle brackets.
        Assert.Contains("This Session has no Node. Select one with", tools);
        // The note is in the Agent store, not in an Agent folder.
        Assert.Equal("kept", await storage.AgentFiles!.ReadTextAsync("main", "memory/NOTES.md", default));
        Assert.False(Directory.Exists(files.Agents));
        // The prompt the model received names no Main-local path.
        var request = (await model.RequestAt(0)).Body;
        Assert.DoesNotContain(files.Agents, request);
        Assert.DoesNotContain(files.Scratch, request);

        replica.Stop.Cancel();
        Assert.Equal(HostedExit.Stopped, await replica.Run.WaitAsync(TimeSpan.FromSeconds(60)));
        Assert.Empty(ScratchOutsideAllowlist(files.Scratch));
        Assert.True(File.Exists(Path.Combine(files.Scratch, "state", "logs", "foxwarm.log")));
        Assert.False(Directory.Exists(files.Agents));
    }
}
