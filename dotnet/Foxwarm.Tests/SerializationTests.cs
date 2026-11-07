using System.Collections;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Vector;
using YamlDotNet.Serialization;

namespace Foxwarm.Tests;

public sealed class SerializationTests
{
    [Fact]
    public void Dynamic_envelopes_preserve_values_escaping_and_borrowed_dom_ownership()
    {
        var owner = JsonNode.Parse("{\"nested\":{\"unknown\":true,\"text\":\"<tag>\"}}")!;
        var values = new Dictionary<string, object?>
        {
            ["borrowed"] = owner["nested"],
            ["integers"] = new object[] { long.MaxValue, ulong.MaxValue },
            ["values"] = new object?[] { null, false, 1.25, "line\n\"quote\"" },
        };
        var expected = JsonSerializer.SerializeToNode(values)!;
        var actual = JsonData.Node(values)!;
        Assert.True(JsonNode.DeepEquals(expected, actual));
        actual["borrowed"]!["unknown"] = false;
        Assert.True(owner["nested"]!["unknown"]!.GetValue<bool>());
        Assert.Equal(JsonSerializer.Serialize(values), JsonData.Serialize(values));
        var relaxed = new JsonSerializerOptions(JsonData.Options)
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        Assert.Equal("\"<tag>\"", JsonData.Serialize("<tag>", relaxed));
    }

    [Fact]
    public void Vector_wire_metadata_preserves_web_names_nulls_and_round_trips()
    {
        var options = new VectorSearchOptions(
            Agent: "example",
            SessionIds: ["example/one"],
            PreferBlocks: true,
            StartTime: 123
        );
        var expected = JsonSerializer.Serialize(
            options,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)
        );
        var wire = JsonData.Serialize(options, VectorWire.Json);
        Assert.Equal(expected, wire);
        var decoded = JsonData.Deserialize<VectorSearchOptions>(wire, VectorWire.Json)!;
        Assert.Equal(options.Agent, decoded.Agent);
        Assert.Equal(options.SessionIds, decoded.SessionIds);
        Assert.Equal(options.PreferBlocks, decoded.PreferBlocks);
        Assert.Equal(options.StartTime, decoded.StartTime);
        Assert.Null(decoded.EndTime);
    }

    [Theory]
    [InlineData("description: 123\ninclude-session: [true, null, 42, 1.5, 2025-01-01]")]
    [InlineData("description: !!str 123\nnumber: !!int 42\nflag: !!bool true\nempty: ~")]
    [InlineData("description: first\ndescription: last")]
    [InlineData("base: &base {description: base}\n<<: *base")]
    [InlineData("- one\n- two")]
    public void Frontmatter_keeps_its_untyped_yaml_rules(string text)
    {
        var original = new DeserializerBuilder().Build().Deserialize<object>(text);
        AssertGraph(original, FrontMatterYaml.Parse(text));
    }

    private static void AssertGraph(object? expected, object? actual)
    {
        Assert.Equal(expected?.GetType(), actual?.GetType());
        if (expected is IDictionary map)
        {
            var result = Assert.IsAssignableFrom<IDictionary>(actual);
            Assert.Equal(map.Count, result.Count);
            foreach (DictionaryEntry item in map)
                AssertGraph(item.Value, result[item.Key]);
        }
        else if (expected is IList list)
        {
            var result = Assert.IsAssignableFrom<IList>(actual);
            Assert.Equal(list.Count, result.Count);
            for (var index = 0; index < list.Count; index++)
                AssertGraph(list[index], result[index]);
        }
        else
            Assert.Equal(expected, actual);
    }
}
