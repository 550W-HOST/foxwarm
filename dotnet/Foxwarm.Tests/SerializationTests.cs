using System.Collections;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Foxwarm.Vector;
using YamlDotNet.Serialization;

namespace Foxwarm.Tests;

public sealed class SerializationTests
{
    internal const string ReadableText = "+ ' \" < > & 中文";

    internal static void AssertReadable(string json)
    {
        foreach (var text in new[] { "+", "'", "\\\"", "<", ">", "&", "中文" })
            Assert.Contains(text, json);
        Assert.DoesNotContain("\\u", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Compact_DOM_text_preserves_the_default_writer_depth()
    {
        var node = new JsonObject { ["value"] = "retained" };
        for (var depth = 0; depth < 80; depth++)
            node = new JsonObject { ["child"] = node };

        Assert.Equal(node.ToJsonString(), node.ToJsonText());
    }

    [Fact]
    public void Persisted_isolation_digests_keep_the_original_escaped_bytes()
    {
        var rules = new JsonArray(new JsonObject { ["text"] = ReadableText });
        Assert.Equal(
            "1804a6b741d235c3c090eb4d1613721f6c14310e16713111057953ce9f0e604d",
            IsolationMigrationRules.Digest(rules)
        );
    }

    [Fact]
    public async Task Shared_serializers_preserve_readable_text_and_required_JSON_escaping()
    {
        var node = new JsonObject { [ReadableText] = ReadableText };
        using var stream = new MemoryStream();
        await JsonData.SerializeAsync(stream, node);
        foreach (
            var json in new[]
            {
                node.ToJsonText(),
                node.ToJsonText(indented: true),
                JsonNode.Parse(node.ToJsonString())!.ToJsonText(),
                JsonData.Serialize(node),
                JsonData.Serialize(node, JsonData.WebOptions),
                Encoding.UTF8.GetString(JsonData.SerializeToUtf8Bytes(node)),
                Encoding.UTF8.GetString(stream.ToArray()),
                JsonSerializer.Serialize(node, MainJsonContext.Text.JsonObject),
            }
        )
        {
            AssertReadable(json);
            Assert.Equal(ReadableText, JsonNode.Parse(json)![ReadableText]!.GetValue<string>());
        }
        const string controls = "line\n\t\r\\\"\0";
        Assert.Equal(
            controls,
            JsonNode.Parse(JsonValue.Create(controls)!.ToJsonText())!.GetValue<string>()
        );
    }

    [Fact]
    public void State_files_and_nested_tool_results_use_the_shared_text_encoder()
    {
        using var temp = new TempDirectory();
        var file = new AtomicJsonFile(temp.Path, "state.json");
        file.WritePayload(new JsonObject { ["text"] = ReadableText });
        var stored = File.ReadAllText(file.FilePath);
        AssertReadable(stored);
        Assert.Equal(ReadableText, JsonNode.Parse(stored)!["text"]!.GetValue<string>());
        var result = new JsonObject { ["output"] = stored };
        var rendered = ToolResponseFormatting.Format(result);
        AssertReadable(rendered);
        Assert.Equal(ReadableText, JsonNode.Parse(rendered)!["text"]!.GetValue<string>());
    }

    [Fact]
    public void Html_script_literals_cannot_terminate_the_script_element()
    {
        const string attack = "</script><img onerror> + ' \" & 中文";
        var literal = JsonValue.Create(attack)!.ToHtmlJson();
        Assert.DoesNotContain("<", literal);
        Assert.Equal(attack, JsonNode.Parse(literal)!.GetValue<string>());
        var html = McpOAuthRoutes.CallbackDocument(attack, attack);
        Assert.DoesNotContain("<img", html);
        Assert.Equal(1, System.Text.RegularExpressions.Regex.Matches(html, "</script>").Count);
        Assert.Contains(literal, html);
    }

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
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(JsonData.Serialize(values))));
        Assert.Equal("\"<tag>\"", JsonData.Serialize("<tag>"));
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
