using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class VisionInputParityTests
{
    [Fact]
    public async Task Real_Source_images_preflight_provider_file_descriptors_and_canonical_persistence_agree()
    {
        using var temp = new TempDirectory();
        var root = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")!;
        var output = Path.Combine(temp.Path, "source.json");
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (
            var argument in new[]
            {
                Path.Combine(root, "dotnet", "vision-input-fixture-ts.mjs"),
                temp.Path,
                output,
            }
        )
            start.ArgumentList.Add(argument);
        using (var child = Process.Start(start)!)
        {
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            await child.WaitForExitAsync();
            Assert.True(child.ExitCode == 0, await stderr + await stdout);
        }
        var oracle = JsonNode.Parse(await File.ReadAllTextAsync(output))!;
        var store = new PersistentSessionAuthorityStore(Path.Combine(temp.Path, "managed"), "s");
        var blobs = store.Images;
        foreach (var row in oracle["cases"]!.AsArray())
        {
            var name = row!["name"]!.ToString();
            var bytes = await File.ReadAllBytesAsync(Path.Combine(temp.Path, name + ".png"));
            Assert.Equal(
                row["oversized"]!.GetValue<bool>(),
                ImageInputPolicy.IsOversized(bytes, "image/png")
            );
            var reference = await blobs.PutAsync(bytes, "image/png", name);
            Assert.Equal(
                oracle["refs"]![name]!["blobId"]!.ToString(),
                reference["blobId"]!.ToString()
            );
            Assert.Equal(bytes, await blobs.ReadAsync(reference));
        }
        foreach (var row in oracle["tiffCases"]!.AsArray())
        {
            var bytes = await File.ReadAllBytesAsync(
                Path.Combine(temp.Path, row!["name"]!.ToString() + ".tif")
            );
            if (row["invalid"]?.GetValue<bool>() == true)
                Assert.Throws<ImageInputException>(() =>
                    ImageInputPolicy.IsOversized(bytes, "image/tiff")
                );
            else
                Assert.Equal(
                    row["oversized"]!.GetValue<bool>(),
                    ImageInputPolicy.IsOversized(bytes, "image/tiff")
                );
        }
        var tiffOptions = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        await using (
            var manager = new SessionManager(
                Path.Combine(temp.Path, "tiff-data"),
                Path.Combine(temp.Path, "tiff-work"),
                tiffOptions,
                HostModels.ForTest(tiffOptions)
            )
        )
        {
            await manager.LoadAsync();
            var owner = await manager.CreateNamedAsync("main", "tiff", null, null);
            var uploads = new Foxwarm.Channels.WebUi.WebUiUploadedFiles(manager);
            var staging = Path.Combine(uploads.Root, Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(staging);
            try
            {
                foreach (var row in oracle["tiffCases"]!.AsArray())
                {
                    var name = row!["name"]!.ToString();
                    var bytes = await File.ReadAllBytesAsync(
                        Path.Combine(temp.Path, name + ".tif")
                    );
                    var path = Path.Combine(staging, name + ".tif");
                    await File.WriteAllBytesAsync(path, bytes);
                    using var ingress = manager.BeginFileIngress(owner);
                    var prepared = await uploads.PrepareAsync(
                        new JsonObject
                        {
                            ["uploadedFiles"] = new JsonArray(
                                new JsonObject
                                {
                                    ["path"] = path,
                                    ["filename"] = name + ".tif",
                                    ["mimeType"] = "image/tiff",
                                }
                            ),
                        },
                        owner,
                        default
                    );
                    var oversized = row["oversized"]?.GetValue<bool>() == true;
                    Assert.StartsWith(
                        oversized ? "<foxwarm-file " : "<foxwarm-image ",
                        prepared.Parts[0]["text"]!.ToString()
                    );
                    Assert.Equal(
                        oversized ? 0 : 1,
                        prepared.Parts.Count(part => part["inlineDataRef"] is not null)
                    );
                    Assert.Equal(
                        bytes,
                        await File.ReadAllBytesAsync(
                            prepared.SavedFiles.Single()["path"]!.ToString()
                        )
                    );
                    Assert.False(File.Exists(path));
                }
            }
            finally
            {
                Directory.Delete(staging, true);
            }
        }
        var messages = oracle["messages"]!.AsArray().OfType<JsonObject>().ToArray();
        var canonical = string.Join('\n', messages.Select(message => message.ToJsonString()));
        foreach (var protocol in new[] { "responses", "completions", "anthropic" })
        {
            var prepared = await blobs.HydrateAsync(messages, protocol);
            var actual = new JsonArray(prepared.Select(row => (JsonNode)row.DeepClone()).ToArray());
            Assert.True(
                JsonNode.DeepEquals(oracle["prepared"], actual),
                "Expected: " + oracle["prepared"] + " Actual: " + actual
            );
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
            var json = wire.ToJsonString();
            Assert.DoesNotContain("base64", json);
            Assert.DoesNotContain("inlineData", json);
            Assert.Contains("foxwarm-file", json);
            Assert.Contains("image_write_to_file", json);
            Assert.Contains("first result", json);
            Assert.Contains("second result", json);
        }
        Assert.Equal(
            canonical,
            string.Join('\n', messages.Select(message => message.ToJsonString()))
        );
        Assert.False(
            Directory.Exists(Path.Combine(blobs.DataRoot, "state", "provider-image-cache"))
        );

        // Normal queue -> canonical append -> authority JSON and immutable Archive retain the original, not provider text.
        var registry = new SessionRegistry(store, new EmptyChat());
        var entry = registry.Add("s");
        registry.TriggerOverride = _ => Task.CompletedTask;
        await registry.Ingress.EnqueueAsync(
            "s",
            QueueItem.UserText("large") with
            {
                Parts = messages[0]["parts"]!
                    .AsArray()
                    .OfType<JsonObject>()
                    .Select(part => (JsonObject)part.DeepClone())
                    .ToArray(),
            }
        );
        await registry.HostFor("s").AppendQueuedInputsAsync(SessionTurnRunner.DrainLeading(entry));
        var committed = entry.Snapshot().History.Materialize().Single();
        var exact = EcmaJson.Stringify(committed);
        await blobs.HydrateAsync([committed], "responses");
        Assert.Equal(exact, store.Archive.ReadMessages().Single().MessageJson);
        Assert.Contains("inlineDataRef", await File.ReadAllTextAsync(store.AuthorityPath));
        var original = committed["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(part => part["inlineDataRef"] is not null)["inlineDataRef"]!.AsObject();
        Assert.Equal("overBytes", original["imageId"]!.ToString());
        var reloaded = (await store.LoadAsync("s"))!;
        Assert.Equal(exact, EcmaJson.Stringify(reloaded.History.Materialize().Single()));
        Assert.Equal(
            await File.ReadAllBytesAsync(Path.Combine(temp.Path, "overBytes.png")),
            await blobs.ReadAsync(original)
        );
        File.Delete(blobs.ResolveBlob(oracle["refs"]!["overPixels"]!["blobId"]!.ToString()));
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.HydrateAsync([messages[1]], "responses")
        );
    }

    private sealed class EmptyChat : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        ) => throw new InvalidOperationException("not used");
    }

    [Fact]
    public async Task Byte_gate_precedes_optional_HEIF_decoder_but_small_malformed_reference_still_fails()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = new byte[ImageInputPolicy.MaxBytes + 1];
        Assert.True(ImageInputPolicy.IsOversized(bytes, "image/heic"));
        var reference = await blobs.PutAsync(bytes, "image/heic", "retained-heif");
        var message = new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["inlineDataRef"] = reference }),
        };
        var prepared = (await blobs.HydrateAsync([message], "responses")).Single();
        Assert.Contains("retained-heif", prepared.ToJsonString());
        Assert.DoesNotContain("inlineData", prepared.ToJsonString());
        Assert.Equal(bytes, await blobs.ReadAsync(reference));
        var malformed = await blobs.PutAsync("not HEIF"u8.ToArray(), "image/heic", "malformed");
        message["parts"] = new JsonArray(new JsonObject { ["inlineDataRef"] = malformed });
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.HydrateAsync([message], "responses")
        );
    }
}
