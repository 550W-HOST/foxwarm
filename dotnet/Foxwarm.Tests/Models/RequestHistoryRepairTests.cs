using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class RequestHistoryRepairTests
{
    private static JsonObject Row(string role, params JsonObject[] parts) => new() { ["role"] = role, ["parts"] = new JsonArray(parts.Select(part => (JsonNode?)part).ToArray()) };
    private static JsonObject Call(string id) => new() { ["functionCall"] = new JsonObject { ["id"] = id, ["name"] = "read", ["args"] = new JsonObject() } };
    private static JsonObject Result(string id) => new() { ["functionResponse"] = new JsonObject { ["tool_use_id"] = id, ["name"] = "read", ["response"] = new JsonObject { ["output"] = "owned result" } } };

    [Fact]
    public void Visibility_precedes_repair_and_canonical_hidden_call_cannot_leave_a_visible_placeholder()
    {
        var hidden = Row("model", Call("hidden")); hidden["modelVisible"] = false;
        var source = new[] { hidden, Row("tool", Result("hidden")), Row("user", new JsonObject { ["text"] = "new real input" }) };
        var bytes = source.Select(row => row.ToJsonString()).ToArray();
        var prepared = ConcreteRequestHistory.PrepareRequest(source, "a/wire");
        Assert.Single(prepared); Assert.Equal("user", prepared[0]["role"]!.GetValue<string>());
        Assert.DoesNotContain("hidden", prepared[0].ToJsonString()); Assert.Equal(bytes, source.Select(row => row.ToJsonString()));
    }

    [Fact]
    public void Missing_batch_outputs_are_request_local_but_exact_append_projection_does_not_fabricate_a_tool_result()
    {
        var call = Row("model", Call("one"), Call("two"));
        var source = new[] { call, Row("user", new JsonObject { ["system"] = "interruption" }), Row("user", new JsonObject { ["text"] = "actual turn boundary" }) };
        var bytes = source.Select(row => row.ToJsonString()).ToArray();
        var repaired = ConcreteRequestHistory.PrepareRequest(source, "a/wire");
        Assert.Equal("tool", repaired[1]["role"]!.GetValue<string>());
        Assert.Equal(["one", "two"], repaired[1]["parts"]!.AsArray().Select(part => part!["functionResponse"]!["tool_use_id"]!.GetValue<string>()));
        Assert.All(repaired[1]["parts"]!.AsArray(), part => Assert.Contains("lost", part!["functionResponse"]!["response"]!["error"]!.GetValue<string>()));
        Assert.Single(ConcreteRequestHistory.Prepare([call], "a/wire"));
        Assert.Equal(bytes, source.Select(row => row.ToJsonString()));
    }

    [Fact]
    public void Pure_system_wrappers_preserve_nearby_response_without_inventing_new_id_validation()
    {
        var source = new[] { Row("model", Call("old")), Row("user", new JsonObject { ["text"] = "<foxwarm-system kind=\"event\" />" }),
            Row("tool", Result("historical-different-id")), Row("user", new JsonObject { ["text"] = "new turn" }), Row("tool", Result("too-late")) };
        var repaired = ConcreteRequestHistory.PrepareRequest(source, "a/wire");
        Assert.Equal(4, repaired.Count);
        Assert.Equal("historical-different-id", repaired[2]["parts"]![0]!["functionResponse"]!["tool_use_id"]!.GetValue<string>());
        Assert.DoesNotContain(repaired, row => row.ToJsonString().Contains("too-late", StringComparison.Ordinal));
    }
}
