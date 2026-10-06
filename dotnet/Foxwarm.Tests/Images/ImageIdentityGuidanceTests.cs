using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class ImageIdentityGuidanceTests
{
    private static JsonObject Message(string role, params JsonObject[] parts) =>
        new()
        {
            ["role"] = role,
            ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part).ToArray()),
        };

    private static JsonObject Part(JsonObject reference, string? call = null) =>
        new() { ["inlineDataRef"] = reference.DeepClone(), ["toolUseId"] = call };

    private static IEnumerable<JsonObject> Objects(JsonNode? node)
    {
        if (node is JsonObject value)
        {
            yield return value;
            foreach (var child in value)
            foreach (var result in Objects(child.Value))
                yield return result;
        }
        else if (node is JsonArray array)
            foreach (var child in array)
            foreach (var result in Objects(child))
                yield return result;
    }

    private static string LabelId(string text)
    {
        var start = text.IndexOf("id=", StringComparison.Ordinal) + 3;
        var end = text.LastIndexOf(", size=", StringComparison.Ordinal);
        if (end < 0)
            end = text.Length - 1;
        return JsonSerializer.Deserialize<string>(text[start..end])!;
    }

    [Theory]
    [InlineData("responses")]
    [InlineData("completions")]
    [InlineData("anthropic")]
    public async Task Visible_occurrences_keep_each_owned_escaped_ID_in_real_protocol_group_when_pixels_deduplicate_and_dropped_model_images_never_seed_seen(
        string protocol
    )
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var a = await blobs.PutAsync(bytes, "image/png", "user]\n\"<identity>");
        var b = await blobs.PutAsync(bytes, "image/png", "native#1");
        var c = await blobs.PutAsync(bytes, "image/png", "sdk#1");
        var dropped = Part(a);
        dropped["imageMeta"] = new JsonObject { ["origin"] = "generated", ["imageId"] = "dropped" };
        var response = new JsonObject
        {
            ["functionResponse"] = new JsonObject
            {
                ["name"] = "read",
                ["tool_use_id"] = "call",
                ["response"] = new JsonObject
                {
                    ["output"] = "Tool pixels",
                    ["business"] = new JsonObject
                    {
                        ["imageMeta"] = new JsonObject { ["imageId"] = "fake" },
                    },
                },
            },
        };
        var history = new[]
        {
            Message("model", dropped),
            Message("user", Part(a)),
            Message("tool", response, Part(b, "call"), Part(c, "call")),
        };
        var original = string.Join('\n', history.Select(row => row.ToJsonString()));
        var prepared = await blobs.HydrateAsync(history, protocol);
        var wire =
            protocol == "responses" ? ResponsesRequestSerializer.ConvertHistory(prepared, "model")
            : protocol == "completions"
                ? CompletionsRequestSerializer.ConvertHistory(
                    prepared,
                    "model",
                    "reasoning_content"
                )
            : AnthropicRequestSerializer.ConvertHistory(prepared, new Uri("http://localhost"));
        var labels = Objects(wire)
            .Where(value =>
                value["text"]
                    ?.GetValue<string>()
                    .StartsWith("[IMAGE: id=", StringComparison.Ordinal) == true
            )
            .ToArray();
        Assert.Equal(
            new[] { a["imageId"]!.GetValue<string>(), "native#1", "sdk#1" },
            labels.Select(label => LabelId(label["text"]!.GetValue<string>()))
        );
        Assert.All(labels, label => Assert.Contains("3x2", label["text"]!.GetValue<string>()));
        Assert.DoesNotContain(
            "dropped",
            labels.Select(label => LabelId(label["text"]!.GetValue<string>()))
        );
        Assert.DoesNotContain(
            "fake",
            labels.Select(label => LabelId(label["text"]!.GetValue<string>()))
        );
        Assert.Equal(1, wire.ToJsonString().Split(Convert.ToBase64String(bytes)).Length - 1);
        Assert.Equal(original, string.Join('\n', history.Select(row => row.ToJsonString())));
        if (protocol == "responses")
            Assert.Equal(
                2,
                Objects(
                        wire.OfType<JsonObject>()
                            .Single(value => value["type"]?.ToString() == "function_call_output")[
                            "output"
                        ]
                    )
                    .Count(value =>
                        value["text"]
                            ?.ToString()
                            .StartsWith("[IMAGE: id=", StringComparison.Ordinal) == true
                    )
            );
        if (protocol == "completions")
        {
            var companion = wire.OfType<JsonObject>()
                .Last(value => value["role"]?.ToString() == "user");
            Assert.Equal(
                2,
                Objects(companion)
                    .Count(value =>
                        value["text"]
                            ?.ToString()
                            .StartsWith("[IMAGE: id=", StringComparison.Ordinal) == true
                    )
            );
            Assert.DoesNotContain(
                "[IMAGE: id=",
                wire.OfType<JsonObject>().Single(value => value["role"]?.ToString() == "tool")[
                    "content"
                ]!.ToString()
            );
        }
        if (protocol == "anthropic")
            Assert.Equal(
                2,
                Objects(wire).Single(value => value["type"]?.ToString() == "tool_result")[
                    "content"
                ]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .Count(value =>
                        value["text"]
                            ?.ToString()
                            .StartsWith("[IMAGE: id=", StringComparison.Ordinal) == true
                    )
            );
    }

    [Fact]
    public void Opaque_business_metadata_and_nonpositive_unknown_dimensions_do_not_forge_labels_or_require_a_decoder()
    {
        var blocks = new JsonArray();
        ProviderImageParts.AddOccurrence(
            blocks,
            new JsonObject
            {
                ["imageMeta"] = new JsonObject { ["imageId"] = "fake" },
                ["response"] = new JsonObject(),
            },
            "responses"
        );
        Assert.Empty(blocks);
        var part = new JsonObject
        {
            ["inlineData"] = new JsonObject { ["mimeType"] = "image/png", ["data"] = "eA==" },
            ["imageMeta"] = new JsonObject
            {
                ["imageId"] = "exact",
                ["width"] = 0,
                ["height"] = 2,
            },
        };
        ProviderImageParts.AddOccurrence(blocks, part, "responses");
        Assert.Equal(2, blocks.Count);
        Assert.Equal("exact", LabelId(blocks[0]!["text"]!.GetValue<string>()));
        Assert.DoesNotContain("size=", blocks[0]!["text"]!.ToString());
    }
}
