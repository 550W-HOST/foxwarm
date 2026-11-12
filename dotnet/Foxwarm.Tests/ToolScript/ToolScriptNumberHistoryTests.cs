using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Foxwarm.ToolScript;

namespace Foxwarm.Tests.ToolScript;

// ToolScript values reach Session history and its Archive as finite binary64 numbers.
public sealed class ToolScriptNumberHistoryTests
{
    private static ResponsesClientOptions Options =>
        new(new Uri("http://127.0.0.1:1"), "wire", "a", "", "", 713);

    // Turn 1 runs a script; turn 2 reads its stored run record back; turn 3 ends.
    private sealed class InspectingChat : IChatService
    {
        private int turns;

        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        )
        {
            var turn = Interlocked.Increment(ref turns);
            if (turn == 1)
                return Reply(
                    Call(
                        "script",
                        "run_script",
                        new JsonObject
                        {
                            ["code"] =
                                "call_tool('read', {'filePath': 'input.txt'})\nreturn {'ratio': 0.1, 'arg': args['x'], 'large': 1e20}\n",
                            ["argsJson"] = "{\"x\": 0.25}",
                        }
                    )
                );
            if (turn == 2)
            {
                var runId = history
                    .SelectMany(row => row["parts"]?.AsArray() ?? [])
                    .Select(part => part?["functionResponse"]?["response"]?["runId"])
                    .Select(node => SessionWait.Text(node))
                    .First(text => text is not null)!;
                return Reply(
                    Call("get", "get_toolscript_run", new JsonObject { ["runId"] = runId }),
                    Call("list", "list_toolscript_runs", new JsonObject())
                );
            }
            return Task.FromResult(
                new ChatResult(
                    new JsonObject
                    {
                        ["role"] = "model",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = "done" }),
                    }
                )
            );
        }

        private static Task<ChatResult> Reply(params JsonObject[] calls) =>
            Task.FromResult(
                new ChatResult(
                    new JsonObject
                    {
                        ["role"] = "model",
                        ["parts"] = new JsonArray(
                            calls
                                .Select(call =>
                                    (JsonNode)new JsonObject { ["functionCall"] = call }
                                )
                                .ToArray()
                        ),
                    }
                )
            );

        private static JsonObject Call(string id, string name, JsonObject args) =>
            new()
            {
                ["id"] = id,
                ["name"] = name,
                ["args"] = args,
            };
    }

    [Fact]
    public async Task Stored_run_record_with_fractional_numbers_is_persisted_into_Session_history()
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        await File.WriteAllTextAsync(Path.Combine(work, "input.txt"), "hello");
        await using var manager = new SessionManager(
            data,
            work,
            Options,
            HostModels.ForTest(Options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "numbers", null, null);
        await using var mcp = new Foxwarm.McpClient(data);
        var definitions = WorkspaceTools.Definitions();
        foreach (var definition in ToolScriptToolDefinitions.Definitions())
            definitions.Add(definition?.DeepClone());
        var registry = SessionToolExecutor.CreateRegistry(definitions, mcp, _ => work);
        var tools = new SessionToolExecutor(new WorkspaceTools(work), owner, manager, registry);
        var host = new LocalSessionTurnHost(
            owner.Entry,
            owner.Registry.Store,
            new InspectingChat(),
            tools
        );
        Assert.True(await host.TryClaimBusyAsync());
        await host.ChatAsync("numbers");

        // History publishes only after the Archive and authority commit succeeded.
        var responses = owner
            .History()
            .Where(row => row["role"]?.ToString() == "tool")
            .SelectMany(row => row["parts"]!.AsArray())
            .Select(part => part!["functionResponse"]!.AsObject())
            .ToDictionary(response => response["name"]!.GetValue<string>());
        var started = responses["run_script"]["response"]!;
        Assert.Equal("completed", SessionWait.Text(started["status"]));
        var inspected = responses["get_toolscript_run"]["response"]!;
        Assert.Equal("completed", SessionWait.Text(inspected["status"]));
        Assert.Equal(0.1, inspected["result"]!["ratio"]!.GetValue<double>());
        Assert.Equal(0.25, inspected["result"]!["arg"]!.GetValue<double>());
        Assert.Equal(1e20, inspected["result"]!["large"]!.GetValue<double>());
        var listed = Assert.Single(
            responses["list_toolscript_runs"]["response"]!["runs"]!.AsArray()
        )!;
        Assert.Equal(0.1, listed["result"]!["ratio"]!.GetValue<double>());

        // Recorded timings are whole milliseconds, in the live result and the stored record.
        static void WholeMilliseconds(JsonNode? value)
        {
            Assert.NotNull(value);
            Assert.DoesNotContain('.', value!.ToJsonString());
            Assert.True(value.GetValue<long>() >= 0);
        }
        var subcall = Assert.Single(inspected["subCalls"]!.AsArray())!;
        WholeMilliseconds(subcall["durationMs"]);
        WholeMilliseconds(inspected["lastHostCall"]!["durationMs"]);
        WholeMilliseconds(listed["subCalls"]![0]!["durationMs"]);
        foreach (var response in responses.Values)
            WholeMilliseconds(response["executionTiming"]!["durationMs"]);
        WholeMilliseconds(
            responses["run_script"]["__meta"]!["toolScriptSubCalls"]![0]!["durationMs"]
        );

        // The persisted authority carries the same numbers as ECMAScript JSON.
        var authority = Directory
            .EnumerateFiles(Path.Combine(data, "state", "sessions"), "*.json")
            .Select(File.ReadAllText)
            .Single(text => text.Contains("get_toolscript_run"));
        Assert.Contains("\"ratio\": 0.1", authority);
        Assert.Contains("\"arg\": 0.25", authority);
    }

    [Fact]
    public void ToolScript_json_numbers_are_int64_or_finite_binary64_never_clr_decimal()
    {
        var parsed = new ToolScriptDataBudget().ParseJson(
            "[0.1, 34107.1914, 1.0, 1e3, 100000000000000000000, 12, -7, 1e308]"u8.ToArray()
        )!;
        var values = parsed.AsArray().Select(node => (JsonValue)node!).ToArray();
        Assert.All(values, value => Assert.False(value.TryGetValue<decimal>(out _)));
        Assert.Equal(0.1, values[0].GetValue<double>());
        Assert.Equal(34107.1914, values[1].GetValue<double>());
        Assert.Equal(1.0, values[2].GetValue<double>());
        Assert.Equal(1000.0, values[3].GetValue<double>());
        Assert.Equal(1e20, values[4].GetValue<double>());
        Assert.Equal(12L, values[5].GetValue<long>());
        Assert.Equal(-7L, values[6].GetValue<long>());
        Assert.Equal(1e308, values[7].GetValue<double>());
        // The Archive admits every parsed value with ECMAScript number text.
        Assert.Equal(
            "[0.1,34107.1914,1,1000,100000000000000000000,12,-7,1e+308]",
            EcmaJson.Stringify(parsed)
        );
        Assert.Throws<System.Text.Json.JsonException>(() =>
            new ToolScriptDataBudget().ParseJson("[1e400]"u8.ToArray())
        );
    }
}
