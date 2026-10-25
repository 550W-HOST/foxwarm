using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CanonicalSequenceCueTests
{
    [Theory]
    [InlineData("responses", false)]
    [InlineData("responses", true)]
    [InlineData("completions", false)]
    [InlineData("completions", true)]
    [InlineData("anthropic", false)]
    [InlineData("anthropic", true)]
    public void Tool_groups_use_the_containing_canonical_seq_with_or_without_timing(string protocol, bool timing)
    {
        var model = JsonNode.Parse("""{"role":"model","__meta":{"seq":41},"parts":[{"functionCall":{"id":"one","name":"read","args":{}}},{"functionCall":{"id":"two","name":"read","args":{}}}]}""")!.AsObject();
        var tool = JsonNode.Parse("""{"role":"tool","__meta":{"seq":42},"parts":[{"functionResponse":{"tool_use_id":"one","name":"read","response":{"output":"first"}}},{"functionResponse":{"tool_use_id":"two","name":"read","response":{"output":"second"}}}]}""")!.AsObject();
        if (timing)
            tool["parts"]![0]!["functionResponse"]!["previousLlmRequest"] = new JsonObject
            {
                ["time"] = "fixture time", ["durationMs"] = 1250,
            };
        var original = tool.ToJsonString();
        var prepared = ConcreteRequestHistory.PrepareRequest([model, tool], "a/wire");
        Assert.Null(prepared[^1]["__meta"]);
        JsonArray wire;
        string[] prefixes;
        if (protocol == "responses")
        {
            wire = ResponsesRequestSerializer.ConvertHistory(prepared, "a/wire");
            prefixes = wire.OfType<JsonObject>().Where(row => SessionWait.Text(row["type"]) == "function_call_output")
                .Select(row => row["output"]!.AsArray()[0]!["text"]!.GetValue<string>()).ToArray();
        }
        else if (protocol == "completions")
        {
            wire = CompletionsRequestSerializer.ConvertHistory(prepared, "a/wire", "reasoning_content");
            prefixes = wire.OfType<JsonObject>().Where(row => SessionWait.Text(row["role"]) == "tool")
                .Select(row => row["content"]!.AsArray()[0]!["text"]!.GetValue<string>()).ToArray();
        }
        else
        {
            wire = AnthropicRequestSerializer.ConvertHistory(prepared, new Uri("http://localhost"));
            prefixes = wire.OfType<JsonObject>().SelectMany(row => (row["content"] as JsonArray)?.OfType<JsonObject>() ?? [])
                .Where(part => SessionWait.Text(part["type"]) == "tool_result")
                .Select(part => part["content"]!.GetValue<string>()).ToArray();
        }
        Assert.Equal(2, prefixes.Length);
        Assert.All(prefixes, prefix => Assert.Contains("seq=\"42\"", prefix));
        Assert.Equal(timing, prefixes[0].Contains("prevLLMReqTime="));
        Assert.DoesNotContain("prevLLMReqTime=", prefixes[1]);
        Assert.Equal(original, tool.ToJsonString());
        Assert.Contains("first", wire.ToJsonString());
        Assert.Contains("second", wire.ToJsonString());
    }

    [Fact]
    public void Request_only_repaired_tool_responses_have_no_invented_sequence()
    {
        var model = JsonNode.Parse("""{"role":"model","__meta":{"seq":41},"parts":[{"functionCall":{"id":"lost","name":"read","args":{}}}]}""")!.AsObject();
        var prepared = ConcreteRequestHistory.PrepareRequest([model], "a/wire");
        var response = prepared[^1]["parts"]![0]!["functionResponse"]!.AsObject();
        Assert.Null(response["contextSeq"]);
        Assert.Null(OpenAIRequestText.PreviousRequest(response));
        var wire = ResponsesRequestSerializer.ConvertHistory(prepared, "a/wire");
        Assert.Contains("Tool output is lost", wire.ToJsonString());
        Assert.DoesNotContain("seq=", wire.ToJsonString());
    }

    [Fact]
    public async Task New_outer_wrappers_get_the_final_seq_in_active_history_and_archive_without_rewriting_nested_or_queued_text()
    {
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(new Uri("http://127.0.0.1:1"), "wire", "a/wire", "", "", 713);
        await using var manager = new SessionManager(Path.Combine(temp.Path, "data"), Path.Combine(temp.Path, "work"), options, HostModels.ForTest(options));
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "seq", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var system = "<foxwarm-message type=\"inter-agent\" seq=\"999\" hint=\"original\">\nQuoted <foxwarm-message seq=\"31\">body</foxwarm-message>\n</foxwarm-message>";
        var input = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(
                new JsonObject { ["system"] = "<foxwarm-system kind=\"session\" currentSessionId=\"seq\" />" },
                new JsonObject { ["system"] = "<foxwarm-system kind=\"time\" />" },
                new JsonObject { ["system"] = system },
                new JsonObject { ["text"] = "separate attachment label" }),
        };
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.Prebuilt(input));
        owner.Entry.WithState(state => DeferredQueueInput.Mark(state.Queue));
        Assert.Contains("seq=\"999\"", owner.Entry.Snapshot().Queue.Single().Message!["parts"]![2]!["system"]!.GetValue<string>());
        await owner.Registry.HostFor(owner.Id).AppendQueuedInputsAsync(owner.Entry.State.Queue.ToArray());
        var row = Assert.Single(owner.History());
        var body = row["parts"]![2]!["system"]!.GetValue<string>();
        Assert.StartsWith("<foxwarm-message type=\"inter-agent\" hint=\"original\"", body);
        Assert.Contains("seq=\"1\"", body);
        Assert.DoesNotContain("999", body);
        Assert.Contains("<foxwarm-message seq=\"31\">body</foxwarm-message>", body);
        Assert.Contains("queueInputHint=", body);
        Assert.DoesNotContain("seq=", row["parts"]![0]!.ToJsonString());
        Assert.Equal(system, input["parts"]![2]!["system"]!.GetValue<string>());
        var archived = JsonNode.Parse(Assert.Single(owner.Archive.ReadMessages()).MessageJson);
        Assert.True(JsonNode.DeepEquals(row, archived));

        // Both alternate new-boundary builders stamp only their new rows, retaining inherited originals.
        var (child, _) = await manager.CreateChildAsync(owner, "child", null, null, null, null);
        var childRow = Assert.Single(child.History());
        Assert.Contains("seq=\"1\"", childRow["parts"]![0]!["system"]!.GetValue<string>());
        var fork = await manager.ForkAsync(owner, "fork");
        Assert.Equal(row.ToJsonString(), fork.History()[0].ToJsonString());
        var boundary = fork.History().Single(item => item["parts"]!.ToJsonString().Contains("history-inherited"));
        var seq = CompactCandidateBuilder.Number(boundary["__meta"]?["seq"]);
        Assert.Contains("seq=\"" + seq + "\"", boundary["parts"]![0]!["system"]!.GetValue<string>());
        Assert.Equal(row.ToJsonString(), owner.History()[0].ToJsonString());
    }
}
