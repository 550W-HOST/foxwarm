using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class MainExecPlacementTests
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

    [Fact]
    public async Task Main_exec_records_node_initial_and_final_cwd_in_archive_metadata_and_toolscript_subcalls()
    {
        if (!LocalExecManager.IsSupported || OperatingSystem.IsWindows())
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(Path.Combine(work, "child"));
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "exec", null, null);
        await using var mcp = new Foxwarm.McpClient(data);
        var definitions = LocalExecManager.Definitions();
        foreach (var definition in ToolScriptToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => work);
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        var host = new LocalSessionTurnHost(
            owner.Entry,
            owner.Registry.Store,
            new OnceChat(
                [
                    new JsonObject
                    {
                        ["id"] = "direct",
                        ["name"] = "exec",
                        ["args"] = new JsonObject { ["command"] = "cd child" },
                    },
                    new JsonObject
                    {
                        ["id"] = "script",
                        ["name"] = "run_script",
                        ["args"] = new JsonObject
                        {
                            ["code"] =
                                "call_tool('exec', {'command': 'cd ..', 'cwd': '$fw_tmp'})\nreturn True\n",
                        },
                    },
                ]
            ),
            tools
        );
        Assert.True(await host.TryClaimBusyAsync());
        await host.ChatAsync("placement");
        var row = owner.History().First(row => row["role"]?.ToString() == "tool");
        var responses = row["parts"]!.AsArray().Select(part => part!["functionResponse"]!).ToArray();

        var direct = responses[0]["__meta"]!["exec"]!;
        Assert.Equal("master", direct["nodeId"]!.GetValue<string>());
        Assert.Equal(work, direct["cwd"]!.GetValue<string>());
        Assert.Equal("default", direct["cwdSource"]!.GetValue<string>());
        Assert.Equal(Path.Combine(work, "child"), direct["finalCwd"]!.GetValue<string>());
        Assert.Null(direct["sessionCwd"]);
        var log = direct["logPath"]!.GetValue<string>();
        Assert.True(File.Exists(log));
        Assert.Equal(
            Path.Combine(work, "child"),
            (await File.ReadAllTextAsync(log + ".cwd.txt")).Trim()
        );
        Assert.False(string.IsNullOrEmpty(direct["execId"]!.GetValue<string>()));

        var subcall = Assert.Single(responses[1]["__meta"]!["toolScriptSubCalls"]!.AsArray())!;
        var nested = subcall["exec"]!;
        Assert.Equal("master", nested["nodeId"]!.GetValue<string>());
        Assert.Equal(Path.Combine(work, "tmp"), nested["cwd"]!.GetValue<string>());
        Assert.Equal("explicit", nested["cwdSource"]!.GetValue<string>());
        Assert.Equal(Path.Combine(work, "child"), nested["sessionCwd"]!.GetValue<string>());
        Assert.Equal(work, nested["finalCwd"]!.GetValue<string>());

        // Display metadata never reaches the model request.
        var projected = (JsonObject)row.DeepClone();
        ConcreteRequestHistory.ProjectDisplayMetadata(projected);
        foreach (var part in projected["parts"]!.AsArray())
            Assert.False(part!["functionResponse"]!.AsObject().ContainsKey("__meta"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Peer_placement_is_bounded_evidence_and_never_reaches_the_tool_result(bool valid)
    {
        var raw = new JsonObject
        {
            ["output"] = "ok",
            [ExecPlacement.Field] = valid
                ? ExecPlacement.Create("C:\\w", "default", "quiet-otter", "C:\\w\\a.log", "C:\\w\\b")
                : new JsonObject { ["cwd"] = "/w", ["cwdSource"] = "forged" },
        };
        var parsed = ExecPlacement.Parse(raw[ExecPlacement.Field]);
        if (valid)
        {
            Assert.Equal("C:\\w", parsed!["cwd"]!.GetValue<string>());
            Assert.Equal("C:\\w\\b", parsed["finalCwd"]!.GetValue<string>());
        }
        else
            Assert.Null(parsed);
        var normalized = RemoteNodeResult.Normalize(raw)!.AsObject();
        Assert.False(normalized.ContainsKey(ExecPlacement.Field));
        Assert.Equal("ok", normalized["output"]!.GetValue<string>());
    }
}
