using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class UnsupportedImageInputTests
{
    private const string Svg =
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 4 4\"><rect width=\"4\" height=\"4\"/></svg>";

    [Fact]
    public async Task Svg_upload_is_an_ordinary_file_without_model_image_part()
    {
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "svg", null, null);
        var uploads = new Foxwarm.Channels.WebUi.WebUiUploadedFiles(manager);
        var staging = Path.Combine(uploads.Root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            var bytes = System.Text.Encoding.UTF8.GetBytes(Svg);
            var path = Path.Combine(staging, "fox.svg");
            await File.WriteAllBytesAsync(path, bytes);
            using var ingress = manager.BeginFileIngress(owner);
            var prepared = await uploads.PrepareAsync(
                new JsonObject
                {
                    ["uploadedFiles"] = new JsonArray(
                        new JsonObject
                        {
                            ["path"] = path,
                            ["filename"] = "fox.svg",
                            ["mimeType"] = "image/svg+xml",
                        }
                    ),
                },
                owner,
                default
            );
            Assert.StartsWith("<foxwarm-file ", prepared.Parts[0]["text"]!.ToString());
            Assert.Contains("mime=\"image/svg+xml\"", prepared.Parts[0]["text"]!.ToString());
            Assert.DoesNotContain(prepared.Parts, part => part["inlineDataRef"] is not null);
            Assert.Equal(
                bytes,
                await File.ReadAllBytesAsync(prepared.SavedFiles.Single()["path"]!.ToString())
            );
        }
        finally
        {
            Directory.Delete(staging, true);
        }
    }

    [Theory]
    [InlineData("image/svg+xml")]
    [InlineData("image/tiff")]
    [InlineData("image/bmp")]
    public async Task Existing_unsupported_image_references_reach_providers_as_files(string mime)
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = System.Text.Encoding.UTF8.GetBytes(Svg);
        var reference = await blobs.PutAsync(bytes, mime, "retained");
        var descriptor = "<foxwarm-image name=\"fox\" node=\"master\" path=\"fox.bin\" />";
        var messages = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = descriptor },
                    new JsonObject { ["inlineDataRef"] = reference }
                ),
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["name"] = "read",
                            ["tool_use_id"] = "call",
                            ["response"] = new JsonObject { ["output"] = "read result" },
                        },
                    },
                    new JsonObject
                    {
                        ["inlineDataRef"] = reference.DeepClone(),
                        ["toolUseId"] = "call",
                    }
                ),
            },
        };
        var canonical = string.Join('\n', messages.Select(message => message.ToJsonString()));
        foreach (var protocol in new[] { "responses", "completions", "anthropic" })
        {
            var prepared = await blobs.HydrateAsync(messages, protocol);
            var wire = (
                protocol == "responses"
                    ? ResponsesRequestSerializer.ConvertHistory(prepared, "model")
                : protocol == "completions"
                    ? CompletionsRequestSerializer.ConvertHistory(
                        prepared,
                        "model",
                        "reasoning_content"
                    )
                : AnthropicRequestSerializer.ConvertHistory(prepared, new Uri("http://localhost"))
            ).ToJsonString();
            Assert.DoesNotContain("base64", wire);
            Assert.DoesNotContain("inlineData", wire);
            Assert.Contains("foxwarm-file", wire);
            Assert.Contains("is not a supported image input format", wire);
            Assert.Contains("read result", wire);
        }
        Assert.Equal(canonical, string.Join('\n', messages.Select(message => message.ToJsonString())));
        Assert.Equal(bytes, await blobs.ReadAsync(reference));
    }
}
