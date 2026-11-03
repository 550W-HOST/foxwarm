using System.Text.Json.Nodes;
using Foxwarm.Channels.WebUi;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed partial class ModelImageInputTests
{
    private const string Placeholder = ProviderImageParts.UnsupportedInputText;

    private static JsonObject Obj(string text) => JsonNode.Parse(text)!.AsObject();

    private static int Count(string text, string value) => text.Split(value).Length - 1;

    [Fact]
    public void Image_input_inherits_model_then_provider_then_defaults_and_defaults_to_true()
    {
        var root = Obj(
            """
            {"defaults":{"imageInput":false},"providers":{
              "a":{"providerType":"openai-completions","models":[{"id":"m"},{"id":"v","imageInput":true},"plain"]},
              "b":{"providerType":"anthropic","imageInput":true,"models":[{"id":"m"},{"id":"t","imageInput":false}]},
              "route":{"providerType":"failover","targets":["a/m","b/m"]},
              "pool":{"providerType":"session-hash","targets":["a/v","b/m"]}}}
            """
        );
        // The legacy app llm block is not an imageInput layer.
        var app = Obj("""{"llm":{"imageInput":"ignored"}}""");
        var catalog = HostModels.Parse(root, app);
        Assert.False(catalog.Resolve("a/m").ImageInput);
        Assert.True(catalog.Resolve("a/v").ImageInput);
        Assert.False(catalog.Resolve("a/plain").ImageInput);
        Assert.True(catalog.Resolve("b/m").ImageInput);
        Assert.False(catalog.Resolve("b/t").ImageInput);
        Assert.False(catalog.Resolve("route").ImageInput);
        Assert.True(catalog.Resolve("pool").ImageInput);

        var listed = WebUiContract.Models(catalog)["models"]!
            .AsArray()
            .OfType<JsonObject>()
            .ToDictionary(
                model => model["key"]!.GetValue<string>(),
                model => model["imageInput"]!.GetValue<bool>()
            );
        Assert.False(listed["a/m"]);
        Assert.True(listed["a/v"]);
        Assert.False(listed["route"]);
        Assert.True(listed["pool"]);

        var fingerprint = catalog.Resolve("route").Configuration["fingerprint"]!.GetValue<string>();
        root.Remove("defaults");
        var defaulted = HostModels.Parse(root, app);
        Assert.True(defaulted.Resolve("a/m").ImageInput);
        Assert.True(defaulted.Resolve("a/plain").ImageInput);
        Assert.False(defaulted.Resolve("b/t").ImageInput);
        Assert.True(defaulted.Resolve("route").ImageInput);
        Assert.NotEqual(
            fingerprint,
            defaulted.Resolve("route").Configuration["fingerprint"]!.GetValue<string>()
        );
        Assert.True(
            HostModels
                .Parse(Obj("""{"providers":{"c":{"models":["m"]}}}"""), new())
                .Resolve("c")
                .ImageInput
        );
    }

    [Theory]
    [InlineData("""{"defaults":{"imageInput":"no"},"providers":{"a":{"models":["m"]}}}""")]
    [InlineData("""{"providers":{"a":{"imageInput":1,"models":["m"]}}}""")]
    [InlineData("""{"providers":{"a":{"models":[{"id":"m","imageInput":null}]}}}""")]
    [InlineData("""{"providers":{"a":{"imageInput":"false"}}}""")]
    [InlineData(
        """{"providers":{"a":{"models":["m","n"]},"r":{"providerType":"failover","targets":["a/m","a/n"],"imageInput":false}}}"""
    )]
    public void Invalid_image_input_settings_are_rejected(string yaml)
    {
        Assert.Throws<InvalidDataException>(() => HostModels.Parse(Obj(yaml), new()));
    }

    private static JsonObject Message(string role, params JsonObject[] parts) =>
        new()
        {
            ["role"] = role,
            ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part.DeepClone()).ToArray()),
        };

    private static JsonObject Uploaded(JsonObject reference, string imageId) =>
        new()
        {
            ["inlineDataRef"] = reference.DeepClone(),
            ["imageMeta"] = new JsonObject
            {
                ["imageId"] = imageId,
                ["mimeType"] = "image/png",
                ["width"] = reference["width"]?.DeepClone(),
                ["height"] = reference["height"]?.DeepClone(),
            },
        };

    private static JsonArray Serialize(IReadOnlyList<JsonObject> history, string protocol) =>
        protocol == "responses" ? ResponsesRequestSerializer.ConvertHistory(history, "m")
        : protocol == "completions"
            ? CompletionsRequestSerializer.ConvertHistory(history, "m", "reasoning_content")
        : AnthropicRequestSerializer.ConvertHistory(history, new Uri("http://localhost"));

    [Theory]
    [InlineData("responses", false)]
    [InlineData("responses", true)]
    [InlineData("completions", false)]
    [InlineData("completions", true)]
    [InlineData("anthropic", false)]
    [InlineData("anthropic", true)]
    public async Task Text_only_targets_receive_placeholders_for_user_tool_and_legacy_images(
        string protocol,
        bool imageInput
    )
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var png = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var jpeg = ImageCodecTests.Raster(SKEncodedImageFormat.Jpeg, 5, 4);
        var reference = await blobs.PutAsync(png, "image/png", "image_cat");
        var history = new[]
        {
            Message(
                "user",
                new JsonObject
                {
                    ["text"] =
                        "<foxwarm-image name=\"cat.png\" node=\"master\" path=\"uploads/cat.png\" />",
                },
                Uploaded(reference, "image_cat")
            ),
            Message(
                "model",
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "call-a",
                        ["name"] = "read",
                        ["args"] = new JsonObject(),
                    },
                }
            ),
            Message(
                "tool",
                new JsonObject
                {
                    ["functionResponse"] = new JsonObject
                    {
                        ["tool_use_id"] = "call-a",
                        ["name"] = "read",
                        ["response"] = new JsonObject { ["output"] = "read cat.png" },
                    },
                },
                new JsonObject
                {
                    ["toolUseId"] = "call-a",
                    ["inlineDataRef"] = reference.DeepClone(),
                    ["imageMeta"] = new JsonObject { ["imageId"] = "call-a#1" },
                }
            ),
            Message(
                "user",
                new JsonObject
                {
                    ["inlineData"] = new JsonObject
                    {
                        ["mimeType"] = "image/jpeg",
                        ["data"] = Convert.ToBase64String(jpeg),
                    },
                },
                new JsonObject { ["text"] = "next" }
            ),
        };
        var original = string.Join('\n', history.Select(message => message.ToJsonString()));
        var hydrated = await blobs.HydrateAsync(history, protocol, imageInput: imageInput);
        Assert.Equal(
            original,
            string.Join('\n', history.Select(message => message.ToJsonString()))
        );
        var wire = Serialize(hydrated, protocol);
        var text = wire.ToJsonString();
        Assert.Contains("[IMAGE: id=\\u0022image_cat\\u0022, size=3x2]", text);
        Assert.Contains("cat.png", text);
        Assert.Contains("read cat.png", text);
        string[] imageMarkers = ["input_image", "image_url", "\"type\":\"image\"", "base64"];
        if (imageInput)
        {
            Assert.DoesNotContain(Placeholder, text);
            Assert.Contains(imageMarkers, text.Contains);
            Assert.Contains("appears earlier", text);
            return;
        }
        Assert.Equal(3, Count(text, Placeholder));
        Assert.DoesNotContain(Convert.ToBase64String(png), text);
        Assert.DoesNotContain(Convert.ToBase64String(jpeg), text);
        Assert.DoesNotContain("appears earlier", text);
        Assert.DoesNotContain("deduplicated", text);
        foreach (var marker in imageMarkers)
            Assert.DoesNotContain(marker, text);
        if (protocol == "completions")
        {
            Assert.DoesNotContain("Images returned by tool_call_id", text);
            var tool = Assert.Single(wire, item => item?["role"]?.GetValue<string>() == "tool")!;
            Assert.Contains(Placeholder, tool["content"]!.ToJsonString());
        }
        if (protocol == "responses")
        {
            var output = Assert.Single(
                wire,
                item => item?["type"]?.GetValue<string>() == "function_call_output"
            )!;
            Assert.Contains(Placeholder, output["output"]!.ToJsonString());
        }
        if (protocol == "anthropic")
        {
            var result = wire.OfType<JsonObject>()
                .SelectMany(item => item["content"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Single(block => block["type"]?.GetValue<string>() == "tool_result");
            Assert.Contains(Placeholder, result["content"]!.ToJsonString());
        }

        // The same canonical rows still hydrate real images for an image-capable target.
        var capable = Serialize(await blobs.HydrateAsync(history, protocol), protocol);
        Assert.DoesNotContain(Placeholder, capable.ToJsonString());
        Assert.Contains(Convert.ToBase64String(jpeg), capable.ToJsonString());
    }

    [Fact]
    public async Task Text_only_hydration_does_not_read_or_reject_unsent_references()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var reference = await blobs.PutAsync(
            ImageCodecTests.Raster(SKEncodedImageFormat.Png),
            "image/png",
            "missing"
        );
        File.Delete(blobs.ResolveBlob(reference["blobId"]!.GetValue<string>()));
        var history = new[] { Message("user", Uploaded(reference, "missing")) };
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.HydrateAsync(history, "completions")
        );
        var wire = Serialize(
            await blobs.HydrateAsync(history, "completions", imageInput: false),
            "completions"
        );
        Assert.Contains(Placeholder, wire.ToJsonString());
    }
}
