using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ToolScriptPresentationTests
{
    [Fact]
    public void Literal_sections_and_block_values_preserve_native_response()
    {
        var response = JsonNode.Parse("""
            {"status":"completed","runId":"literal","stdout":"printed \"quotes\" and \\path\n--- return ---\n","result":"{\"not\":\"decoded\"}\n---\nlast \\line"}
            """)!;
        var before = response.ToJsonString();
        var text = ToolResponseFormatting.FormatToolScriptExecution(response);
        Assert.StartsWith("--- print ---\nprinted \"quotes\" and \\path\n--- return ---\n--- return ---\n{\"not\":\"decoded\"}\n---\nlast \\line\n---\n", text);
        Assert.Contains("status: completed", text);
        Assert.Equal(before, response.ToJsonString());
        foreach (var (json, expected) in new[] { ("null", "null"), ("false", "false"), ("0", "0"), ("\"\"", ""), ("[]", "[]"), ("{}", "{}") })
        {
            var value = new JsonObject { ["result"] = JsonNode.Parse(json) };
            Assert.StartsWith("--- return ---\n" + expected + "\n---\n", ToolResponseFormatting.FormatToolScriptExecution(value));
        }
        var structured = JsonNode.Parse("""{"result":{"items":[{"text":"first\nsecond","done":false}]},"error":"Traceback:\nValueError: failed"}""");
        var block = ToolResponseFormatting.FormatToolScriptExecution(structured);
        Assert.Contains("items:\n", block);
        Assert.Contains("- text: |-\n", block);
        Assert.Contains("error: |-\n", block);
        Assert.DoesNotContain("{items:", block);
        var typed = JsonNode.Parse("""{"result":{"nothing":null,"string":"false","flag":false,"text":"first\nsecond","items":[null,false,0]}}""")!;
        var rendered = ToolResponseFormatting.FormatToolScriptExecution(typed);
        var yaml = rendered["--- return ---\n".Length..rendered.LastIndexOf("---\n", StringComparison.Ordinal)];
        var parsed = Foxwarm.ConfigurationYaml.Parse(yaml, "execution result");
        Assert.Null(parsed["nothing"]);
        Assert.Equal("false", parsed["string"]!.GetValue<string>());
        Assert.False(parsed["flag"]!.GetValue<bool>());
        Assert.Equal("first\nsecond", parsed["text"]!.GetValue<string>());
        Assert.Null(parsed["items"]![0]);
        Assert.StartsWith("---\n", ToolResponseFormatting.FormatToolScriptExecution(new JsonObject { ["status"] = "waiting" }));
    }

    [Fact]
    public async Task Guard_measures_and_saves_outer_presentation_but_native_and_historical_values_remain_distinct()
    {
        using var temp = new TempDirectory();
        var shortResponse = new JsonObject { ["status"] = "completed", ["stdout"] = string.Concat(Enumerable.Repeat("x\n", 15000)), ["result"] = false };
        var guarded = await ToolOutputGuard.GuardAsync(shortResponse, temp.Path, "short", true);
        Assert.Same(shortResponse, guarded);
        Assert.True((await ToolOutputGuard.GuardAsync(shortResponse, temp.Path, "ordinary"))!["outputTruncated"]!.GetValue<bool>());
        Assert.False(guarded!["result"]!.GetValue<bool>());
        var large = new JsonObject { ["status"] = "completed", ["stdout"] = new string('x', 41000), ["result"] = false };
        var saved = await ToolOutputGuard.GuardAsync(large, temp.Path, "large", true);
        Assert.Equal(ToolResponseFormatting.FormatToolScriptExecution(large), await File.ReadAllTextAsync(saved!["outputFullPath"]!.GetValue<string>()));
        Assert.Equal(ToolResponseFormatting.Format(saved), ToolResponseFormatting.FormatToolScriptExecution(saved));
        foreach (var json in new[] { "{\"output\":\"historical excerpt\",\"runId\":\"old\"}", "{\"truncated\":true,\"output\":\"excerpt\",\"fullOutputPath\":\"saved.txt\"}" })
        {
            var summary = JsonNode.Parse(json);
            Assert.Equal(ToolResponseFormatting.Format(summary), ToolResponseFormatting.FormatToolScriptExecution(summary));
        }
    }

    [Fact]
    public void Only_canonical_subcall_metadata_projects_request_values_not_result_keys_or_tool_names()
    {
        var native = JsonNode.Parse("""{"status":"completed","stdout":"literal\n","result":{"__meta":{"toolScriptSubCalls":[]},"value":false}}""")!;
        var message = new JsonObject
        {
            ["role"] = "tool",
            ["parts"] = new JsonArray(new JsonObject
            {
                ["functionResponse"] = new JsonObject
                {
                    ["name"] = "unrelated_name",
                    ["response"] = native.DeepClone(),
                    ["__meta"] = new JsonObject { ["toolScriptSubCalls"] = new JsonArray() },
                },
            }),
        };
        var original = message.ToJsonString();
        var projected = ConcreteRequestHistory.Prepare([message], "model")[0]["parts"]![0]!["functionResponse"]!;
        Assert.Equal(ToolResponseFormatting.FormatToolScriptExecution(native), projected["response"]!["output"]!.GetValue<string>());
        Assert.Null(projected["__meta"]);
        Assert.Equal(original, message.ToJsonString());
        message["parts"]![0]!["functionResponse"]!.AsObject().Remove("__meta");
        message["parts"]![0]!["functionResponse"]!["name"] = "run_script";
        var ordinary = ConcreteRequestHistory.Prepare([message], "model")[0]["parts"]![0]!["functionResponse"]!["response"];
        Assert.True(JsonNode.DeepEquals(native, ordinary));
    }
}
