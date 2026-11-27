using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class ToolCallControlsTests
{
    private static JsonObject Obj(string raw) => JsonNode.Parse(raw)!.AsObject();

    private static JsonObject Call(string name, JsonObject args, bool malformed = false)
    {
        var call = new JsonObject
        {
            ["id"] = name,
            ["name"] = name,
            ["args"] = args.DeepClone(),
        };
        if (malformed)
            call["argsParseError"] = "Malformed arguments.";
        return call;
    }

    [Fact]
    public void Cancellation_strips_only_outer_controls_without_mutating_canonical_calls()
    {
        var plain = Obj("""{"sessionId":"target","message":"task"}""");
        var cancelled = Obj("""{"sessionId":"target","message":"task","__cancelTool":true}""");
        var invalid = Obj("""{"sessionId":"target","message":"task","__cancelTool":false}""");
        var malformed = Call(
            "create_child_session",
            Obj("""{"__cancelAllToolsThisTurn":true}"""),
            true
        );
        var direct = ToolCallControls.Plan(
            [
                Call("send_to_session", plain),
                Call("create_child_session", cancelled),
                Call("send_to_session", invalid),
                malformed,
            ]
        );
        Assert.Null(direct[0].Preset);
        Assert.True(direct[1].Preset!["canceled"]!.GetValue<bool>());
        Assert.NotNull(direct[2].Preset.FailureMessage());
        Assert.Null(direct[3].Preset);
        Assert.True(cancelled.ContainsKey("__cancelTool"));
        Assert.False(direct[1].Call["args"]!.AsObject().ContainsKey("__cancelTool"));

        var all = Call("exec", Obj("""{"command":"unused","__cancelAllToolsThisTurn":true}"""));
        Assert.All(
            ToolCallControls.Plan([Call("send_to_session", plain), all, malformed]),
            item => Assert.True(item.Preset!["canceled"]!.GetValue<bool>())
        );

        // Controls nested inside a unified call's arguments belong to the inner call.
        var unified = Call(
            "ctl",
            CtlTestArgs.Unified(
                new JsonObject { ["toolId"] = "builtin:send_to_session", ["args"] = plain.DeepClone() }
            )
        );
        Assert.Null(ToolCallControls.Plan([unified])[0].Preset);
        unified["args"]!["values"]!["args"]!["__cancelTool"] = true;
        Assert.True(
            ToolCallControls.Plan([unified])[0].Call["args"]!["values"]!["args"]!
                .AsObject()
                .ContainsKey("__cancelTool")
        );
    }
}
