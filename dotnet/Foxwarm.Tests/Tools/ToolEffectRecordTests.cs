using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// Audit evidence on tool rows: the resolved capability, its Node and the deciding rules.
public sealed class ToolEffectRecordTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    private sealed class OnceChat(JsonObject[] calls) : IChatService
    {
        private int turns;

        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) =>
            Task.FromResult(
                new ChatResult(
                    Interlocked.Increment(ref turns) == 1
                        ? new JsonObject
                        {
                            ["role"] = "model",
                            ["parts"] = new JsonArray(
                                calls
                                    .Select(call =>
                                        (JsonNode)
                                            new JsonObject { ["functionCall"] = call.DeepClone() }
                                    )
                                    .ToArray()
                            ),
                        }
                        : new JsonObject
                        {
                            ["role"] = "model",
                            ["parts"] = new JsonArray(new JsonObject { ["text"] = "done" }),
                        }
                )
            );
    }

    private static JsonObject Call(string id, string name, JsonObject args) =>
        new()
        {
            ["id"] = id,
            ["name"] = name,
            ["args"] = args,
        };

    [Fact]
    public async Task Every_resolved_call_records_its_target_node_and_deciding_rules()
    {
        if (!LocalExecManager.IsSupported || OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        Directory.CreateDirectory(Path.Combine(data, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(data, "state", "tool-authorization.yaml"),
            "version: 1\ndefaultAction: allow\nrules:\n"
                + "- id: no-notes\n  action: deny\n  reason: Notes are read-only.\n  match:\n    tool: {source: node, name: write}\n"
                + "- id: shell\n  action: allow\n  match:\n    tool: {source: node, name: exec}\n"
        );
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "effects", null, null);
        await using var mcp = new Foxwarm.McpClient(data);
        var definitions = LocalExecManager.Definitions();
        foreach (var definition in ToolScriptToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        foreach (var definition in WorkspaceTools.Definitions())
            definitions.Add(definition?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => work);
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        var host = new LocalSessionTurnHost(
            owner.Entry,
            owner.Registry.Store,
            new OnceChat([
                Call("exec", "exec", new JsonObject { ["command"] = "true" }),
                Call(
                    "denied",
                    "write",
                    new JsonObject { ["filePath"] = "note.txt", ["content"] = "x" }
                ),
                Call(
                    "script",
                    "run_script",
                    new JsonObject
                    {
                        ["code"] = "call_tool('exec', {'command': 'true'})\nreturn 1\n",
                    }
                ),
                Call("unknown", "no_such_tool", new JsonObject()),
            ]),
            tools
        );
        Assert.True(await host.TryClaimBusyAsync());
        await host.ChatAsync("effects");
        var row = owner.History().First(row => row["role"]?.ToString() == "tool");
        var responses = row["parts"]!
            .AsArray()
            .Select(part => part!["functionResponse"]!)
            .ToArray();

        var exec = responses[0]["__meta"]!["target"]!;
        Assert.Equal("node", exec["source"]!.GetValue<string>());
        Assert.Equal("exec", exec["name"]!.GetValue<string>());
        Assert.Equal("master", exec["node"]!.GetValue<string>());
        JsonNode Global(JsonNode target) =>
            target["rules"]!
                .AsArray()
                .Single(rule => rule!["layer"]!.GetValue<string>() == "global")!;
        var rule = Global(exec);
        Assert.Equal("global", rule["layer"]!.GetValue<string>());
        Assert.Equal("shell", rule["id"]!.GetValue<string>());
        Assert.Equal("allow", rule["effect"]!.GetValue<string>());

        // A denied call keeps the rule that denied it beside its ordinary error.
        Assert.Equal(
            "tool_authorization_denied",
            responses[1]["response"]!["error"]!["type"]!.GetValue<string>()
        );
        var denied = responses[1]["__meta"]!["target"]!;
        Assert.Equal("write", denied["name"]!.GetValue<string>());
        Assert.Equal("no-notes", Global(denied)["id"]!.GetValue<string>());
        Assert.Equal("deny", Global(denied)["effect"]!.GetValue<string>());
        Assert.False(File.Exists(Path.Combine(work, "note.txt")));

        var script = responses[2]["__meta"]!;
        Assert.Equal("run_script", script["target"]!["name"]!.GetValue<string>());
        Assert.Equal("defaultAction", Global(script["target"]!)["id"]!.GetValue<string>());
        var subcall = Assert.Single(script["toolScriptSubCalls"]!.AsArray())!;
        Assert.Equal("exec", subcall["target"]!["name"]!.GetValue<string>());
        Assert.Equal("master", subcall["target"]!["node"]!.GetValue<string>());
        Assert.Equal("shell", Global(subcall["target"]!)["id"]!.GetValue<string>());

        // An unresolved call has no target: unknown is not guessed.
        Assert.Null(responses[3]["__meta"]?["target"]);

        var projected = (JsonObject)row.DeepClone();
        ConcreteRequestHistory.ProjectDisplayMetadata(projected);
        foreach (var part in projected["parts"]!.AsArray())
            Assert.False(part!["functionResponse"]!.AsObject().ContainsKey("__meta"));
    }

    [Fact]
    public void Scoped_projection_removes_the_sender_without_touching_the_shared_payload()
    {
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = "hi" }),
            ["__meta"] = new JsonObject
            {
                ["seq"] = 3,
                ["sender"] = InputSender.Identity("reviewer"),
            },
        };
        var payload = new JsonObject
        {
            ["type"] = "history",
            ["messages"] = new JsonArray(message),
        };
        var projected = InputSender.Without(payload)!;
        Assert.NotSame(payload, projected);
        Assert.Null(projected["messages"]![0]!["__meta"]!["sender"]);
        Assert.Equal(3, projected["messages"]![0]!["__meta"]!["seq"]!.GetValue<int>());
        Assert.NotNull(message["__meta"]!["sender"]);

        var plain = new JsonObject { ["messages"] = new JsonArray() };
        Assert.Same(plain, InputSender.Without(plain));
    }
}
