using System.Security.Cryptography;
using System.Text;
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
        Assert.All(
            labels,
            label =>
            {
                Assert.Contains("3x2", label["text"]!.GetValue<string>());
                Assert.DoesNotContain("sent_size", label["text"]!.GetValue<string>());
            }
        );
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

    [Theory]
    [InlineData("responses")]
    [InlineData("completions")]
    [InlineData("anthropic")]
    public async Task Resized_occurrences_report_transmitted_dimensions_after_cache_hits_and_dedup_without_changing_originals(
        string protocol
    )
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png, 390, 3600);
        var reference = await blobs.PutAsync(bytes, "image/png", "original");
        var duplicate = await blobs.PutAsync(bytes, "image/png", "tool-copy");
        var history = new[]
        {
            Message("user", Part(reference)),
            Message(
                "tool",
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["name"] = "read",
                        ["tool_use_id"] = "call",
                        ["response"] = new JsonObject { ["output"] = "pixels" },
                    },
                },
                Part(duplicate, "call")
            ),
        };
        var original = string.Join('\n', history.Select(row => row.ToJsonString()));

        // This image passed through the previous 4096-edge policy. Its valid old cache
        // entry must not bypass the current resize policy.
        var oldKey = Convert.ToHexStringLower(
            SHA256.HashData(
                Encoding.UTF8.GetBytes(
                    Convert.ToHexStringLower(SHA256.HashData(bytes))
                        + "\0image/png\0webp\0skia4.153.1-heif1.23.5-v1"
                )
            )
        );
        var cacheRoot = Path.Combine(temp.Path, "state", "provider-image-cache", "dotnet-v1");
        var oldPath = Path.Combine(cacheRoot, oldKey[..2], oldKey + ".cache");
        Directory.CreateDirectory(Path.GetDirectoryName(oldPath)!);
        await File.WriteAllTextAsync(
            oldPath,
            new JsonObject
            {
                ["key"] = oldKey,
                ["inputMime"] = "image/png",
                ["inputLength"] = bytes.Length,
                ["resultMime"] = "image/png",
                ["passThrough"] = true,
                ["resultSha256"] = Convert.ToHexStringLower(SHA256.HashData(bytes)),
            }.ToJsonString() + "\n"
        );

        string? cachePath = null;
        var stamp = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var prepared = await new ImageBlobStore(temp.Path).HydrateAsync(history, protocol);
            var wire =
                protocol == "responses"
                    ? ResponsesRequestSerializer.ConvertHistory(prepared, "model")
                : protocol == "completions"
                    ? CompletionsRequestSerializer.ConvertHistory(
                        prepared,
                        "model",
                        "reasoning_content"
                    )
                : AnthropicRequestSerializer.ConvertHistory(prepared, new Uri("http://localhost"));
            var labels = Objects(wire)
                .Select(value => value["text"]?.ToString())
                .Where(text => text?.StartsWith("[IMAGE: id=", StringComparison.Ordinal) == true)
                .ToArray();
            Assert.Equal(2, labels.Length);
            Assert.All(
                labels,
                label =>
                    Assert.Contains(
                        ", size=390x3600, sent_size=277x2560] image_crop coordinates use the original size.",
                        label
                    )
            );
            Assert.Equal(new[] { "original", "tool-copy" }, labels.Select(text => LabelId(text!)));
            var images = Objects(wire)
                .Where(value =>
                    value["type"]?.ToString() is "input_image" or "image_url" or "image"
                )
                .ToArray();
            var image = Assert.Single(images);
            var data =
                protocol == "anthropic"
                    ? image["source"]!["data"]!.ToString()
                    : (
                        protocol == "responses"
                            ? image["image_url"]!.ToString()
                            : image["image_url"]!["url"]!.ToString()
                    ).Split(',')[1];
            var encoded = RasterCodec.Inspect(Convert.FromBase64String(data), "image/webp");
            Assert.Equal((277, 2560), (encoded.Width, encoded.Height));
            Assert.Contains("not repeated here", wire.ToJsonString());
            Assert.DoesNotContain("sent_size", prepared[0].ToJsonString());
            Assert.Equal(original, string.Join('\n', history.Select(row => row.ToJsonString())));
            Assert.Equal(bytes, await blobs.ReadAsync(reference));
            if (attempt == 0)
            {
                cachePath = Assert.Single(
                    Directory.GetFiles(cacheRoot, "*.cache", SearchOption.AllDirectories),
                    path => path != oldPath
                );
                File.SetLastWriteTimeUtc(cachePath, stamp);
            }
            else
                Assert.Equal(stamp, File.GetLastWriteTimeUtc(cachePath!));
        }
    }

    [Fact]
    public async Task Native_generated_replay_keeps_original_bytes_while_later_tool_vision_resizes()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png, 390, 3600);
        var reference = await blobs.PutAsync(bytes, "image/png", "generated");
        var generated = Part(reference);
        generated["imageMeta"] = new JsonObject
        {
            ["imageId"] = "generated",
            ["origin"] = "generated",
        };
        generated["providerMeta"] = new JsonObject
        {
            ["openaiResponses"] = new JsonObject
            {
                ["sourceModelId"] = "a/m",
                ["outputItem"] = new JsonObject
                {
                    ["type"] = "image_generation_call",
                    ["id"] = "generation",
                    ["status"] = "completed",
                    ["output_format"] = "png",
                },
            },
        };
        var history = new[]
        {
            Message("model", generated),
            Message(
                "tool",
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["name"] = "read",
                        ["tool_use_id"] = "read",
                        ["response"] = new JsonObject { ["output"] = "pixels" },
                    },
                },
                Part(reference, "read")
            ),
        };
        var prepared = await blobs.HydrateAsync(history, "responses", concreteModelId: "a/m");
        var wire = ResponsesRequestSerializer.ConvertHistoryWithImages(prepared, "a/m", blobs);
        var replay = Assert.Single(
            wire,
            item => item?["type"]?.ToString() == "image_generation_call"
        );
        Assert.Equal(Convert.ToBase64String(bytes), replay!["result"]!.ToString());
        Assert.Single(Objects(wire), item => item["type"]?.ToString() == "input_image");
        var tool = Assert.Single(wire, item => item?["type"]?.ToString() == "function_call_output");
        Assert.Contains("sent_size=277x2560", tool!.ToJsonString());
        Assert.Null(generated["inlineData"]);
        Assert.Equal(bytes, await blobs.ReadAsync(reference));
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
        ProviderImageParts.SetSentDimensions(part, 1, 1);
        ProviderImageParts.AddOccurrence(blocks, part, "responses");
        Assert.Equal(2, blocks.Count);
        Assert.Equal("exact", LabelId(blocks[0]!["text"]!.GetValue<string>()));
        Assert.DoesNotContain("size=", blocks[0]!["text"]!.ToString());
        part.Remove("imageMeta");
        blocks.Clear();
        ProviderImageParts.AddOccurrence(blocks, part, "responses");
        Assert.Equal("input_image", Assert.Single(blocks)!["type"]!.ToString());
    }
}
