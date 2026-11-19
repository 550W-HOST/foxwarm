using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Tools;

// The golden texts the shared TypeScript formatter is tested against
// (packages/shared/src/toolResponseFormatting.test.ts): model and WebUI text must be identical.
public sealed class ToolResponseFormattingParityTests
{
    private static JsonObject Fixtures() =>
        JsonNode
            .Parse(
                File.ReadAllText(
                    Path.Combine(
                        AppContext.BaseDirectory,
                        "Tools",
                        "Fixtures",
                        "toolResponseFormatting.fixtures.json"
                    )
                )
            )!
            .AsObject();

    [Fact]
    public void PayloadTextsMatchTheSharedFormatter()
    {
        var cases = Fixtures()["payload"]!.AsArray();
        Assert.NotEmpty(cases);
        foreach (var item in cases)
            Assert.Equal(
                (Name: item!["name"]!.GetValue<string>(), Text: item["text"]!.GetValue<string>()),
                (
                    Name: item["name"]!.GetValue<string>(),
                    Text: ToolResponseFormatting.Format(item["value"]?.DeepClone())
                )
            );
    }

    [Fact]
    public void ToolScriptTextsMatchTheSharedFormatter()
    {
        var cases = Fixtures()["toolScript"]!.AsArray();
        Assert.NotEmpty(cases);
        foreach (var item in cases)
            Assert.Equal(
                (Name: item!["name"]!.GetValue<string>(), Text: item["text"]!.GetValue<string>()),
                (
                    Name: item["name"]!.GetValue<string>(),
                    Text: ToolResponseFormatting.FormatToolScriptExecution(
                        item["value"]?.DeepClone()
                    )
                )
            );
    }

    [Fact]
    public void ValuesBuiltInMemoryFormatLikeParsedJson()
    {
        // Results are formatted before and after persistence; CLR-typed leaves must not differ.
        var built = new JsonObject
        {
            ["count"] = 3,
            ["ratio"] = 0.5,
            ["big"] = 1e21,
            ["flag"] = true,
            ["items"] = new JsonArray("a", 2L, null),
        };
        Assert.Equal(
            ToolResponseFormatting.Format(JsonNode.Parse(built.ToJsonString())),
            ToolResponseFormatting.Format(built)
        );
        Assert.Equal("count: 3\nratio: 0.5\nbig: 1e+21\nflag: true\nitems:\n  - a\n  - 2\n  - null", ToolResponseFormatting.Format(built));
    }
}
