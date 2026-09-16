using System.Text.Json.Nodes;
using Foxwarm.MessageJson;

namespace Foxwarm.ConditionalMemory.Tests;

public class MessageJsonTests
{
    [Fact]
    public void Round_trips_open_parts_and_presence_without_mutation_or_aliasing()
    {
        var input = "{\"role\":\"model\",\"modelVisible\":null,\"parts\":[{\"text\":\"\",\"phase\":null,\"unknown\":{\"nested\":[null,{}]},\"fields\":[1,-0.0,1e-6]}],\"extra\":{\"x\":true}}";
        var message = CanonicalMessage.Parse(input);
        Assert.Equal("model", message.Role);
        Assert.True(message.Parts[0].Has("phase"));
        Assert.Equal("", message.Parts[0].GetString("text"));
        var copy = message.ToJson();
        ((JsonObject)copy["parts"]![0]!["unknown"]!["nested"]![1]!)!["added"] = true;
        Assert.DoesNotContain("added", message.ToJson().ToJsonString());
        Assert.Equal(input, message.ToJson().ToJsonString());
    }

    [Fact]
    public void Visibility_is_exact_false_only_and_roles_are_bounded()
    {
        var visible = CanonicalMessage.Parse("{\"role\":\"user\",\"parts\":[]}");
        var nullValue = CanonicalMessage.Parse("{\"role\":\"user\",\"modelVisible\":null,\"parts\":[]}");
        var hidden = CanonicalMessage.Parse("{\"role\":\"user\",\"modelVisible\":false,\"parts\":[]}");
        Assert.True(visible.IsModelVisible);
        Assert.True(nullValue.IsModelVisible);
        Assert.False(hidden.IsModelVisible);
        Assert.Throws<FormatException>(() => CanonicalMessage.Parse("{\"role\":\"developer\",\"parts\":[]}"));
    }

    [Fact]
    public void Tool_arguments_preserve_raw_text_and_parse_nested_objects()
    {
        var raw = "{  \"b\":2,\n  \"a\":[null,{\"x\":-0.0}] }";
        var parsed = FunctionCallArguments.Parse(JsonValue.Create(raw));
        Assert.Equal(raw, parsed.RawArgsText);
        Assert.Null(parsed.ArgsParseError);
        Assert.Equal(raw, FunctionCallArguments.Stringify(parsed.Args, parsed.RawArgsText));
        var failed = FunctionCallArguments.Parse(JsonValue.Create("{"));
        Assert.StartsWith("Invalid tool arguments JSON:", failed.ArgsParseError);
        Assert.Contains("rawArgsText", FunctionCallArguments.Stringify(failed.Args, failed.RawArgsText, failed.ArgsParseError));
        Assert.Equal("{}", FunctionCallArguments.Stringify(new JsonObject()));
    }
}
