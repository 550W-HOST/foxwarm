using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

internal static class ResponsesRequestShape
{
    // A Responses request carries its system prompt as the leading developer input item, never
    // as top-level `instructions`.
    internal static string SystemPrompt(JsonNode body)
    {
        Assert.Null(body["instructions"]);
        var first = Assert.IsType<JsonObject>(body["input"]![0]);
        Assert.Equal("message", first["type"]!.GetValue<string>());
        Assert.Equal("developer", first["role"]!.GetValue<string>());
        var content = Assert.IsType<JsonObject>(Assert.Single(first["content"]!.AsArray()));
        Assert.Equal("input_text", content["type"]!.GetValue<string>());
        return content["text"]!.GetValue<string>();
    }

    // The request's history items, after its leading system prompt.
    internal static JsonArray History(JsonNode body)
    {
        SystemPrompt(body);
        return new JsonArray(
            body["input"]!.AsArray().Skip(1).Select(item => item?.DeepClone()).ToArray()
        );
    }
}
