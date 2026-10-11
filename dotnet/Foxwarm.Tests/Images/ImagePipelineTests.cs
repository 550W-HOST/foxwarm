using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class ImagePipelineTests
{
    private static JsonObject Image(byte[] bytes, string mime = "image/png") =>
        new()
        {
            ["inlineData"] = new JsonObject
            {
                ["mimeType"] = mime,
                ["data"] = Convert.ToBase64String(bytes),
            },
        };

    private static JsonObject Message(string role, params JsonObject[] parts) =>
        new()
        {
            ["role"] = role,
            ["parts"] = new JsonArray(parts.Select(part => (JsonNode)part.DeepClone()).ToArray()),
        };

    private static JsonObject Tool(string id, JsonObject payload) =>
        new()
        {
            ["functionResponse"] = new JsonObject
            {
                ["tool_use_id"] = id,
                ["name"] = "read",
                ["response"] = payload.DeepClone(),
            },
        };

    private static JsonObject ToolImage(string id, JsonObject reference) =>
        new() { ["toolUseId"] = id, ["inlineDataRef"] = reference.DeepClone() };

    [Fact]
    public async Task Original_bytes_are_content_addressed_verified_and_never_replaced_by_provider_variants()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var first = await blobs.PutAsync(bytes, "image/png", "one");
        var second = await blobs.PutAsync(bytes, "image/png", "two");
        Assert.Equal(first["blobId"]!.ToString(), second["blobId"]!.ToString());
        Assert.NotEqual(first["imageId"]!.ToString(), second["imageId"]!.ToString());
        Assert.Equal(bytes, await blobs.ReadAsync(first));
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), first["sha256"]!.ToString());
        Assert.Throws<ImageInputException>(() => blobs.ResolveBlob("../other"));
        await File.WriteAllBytesAsync(
            blobs.ResolveBlob(first["blobId"]!.ToString()),
            "wrong"u8.ToArray()
        );
        await Assert.ThrowsAsync<ImageInputException>(() => blobs.ReadAsync(first));
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.PutAsync(bytes, "image/png", "three")
        );
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.PutAsync(bytes, "image/jpeg", "wrong-mime")
        );
    }

    [Fact]
    public async Task Source_carriers_preserve_nonimage_business_fields_and_ordered_call_associated_references()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var png = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var jpg = ImageCodecTests.Raster(SKEncodedImageFormat.Jpeg);
        var business = new JsonObject
        {
            ["data"] = Convert.ToBase64String(png),
            ["mimeType"] = "application/business",
            ["metadata"] = new JsonObject { ["image"] = true },
        };
        var message = Message(
            "tool",
            Tool(
                "call",
                new JsonObject
                {
                    ["output"] = "kept",
                    ["business"] = business.DeepClone(),
                    ["inlineData"] = Image(png)["inlineData"]!.DeepClone(),
                    ["inlineDataItems"] = new JsonArray(
                        Image(jpg, "image/jpeg")["inlineData"]!.DeepClone()
                    ),
                }
            )
        );
        await blobs.ExternalizeMessageAsync(message);
        var parts = message["parts"]!.AsArray();
        Assert.Equal(3, parts.Count);
        Assert.True(
            JsonNode.DeepEquals(business, parts[0]!["functionResponse"]!["response"]!["business"])
        );
        Assert.Null(parts[0]!["functionResponse"]!["response"]!["inlineData"]);
        Assert.Null(parts[0]!["functionResponse"]!["response"]!["inlineDataItems"]);
        Assert.Equal(
            new[] { "call#1", "call#2" },
            parts.Skip(1).Select(part => part!["inlineDataRef"]!["imageId"]!.ToString())
        );
        Assert.All(parts.Skip(1), part => Assert.Equal("call", part!["toolUseId"]!.ToString()));
        Assert.Equal(png, await blobs.ReadAsync(parts[1]!["inlineDataRef"]!.AsObject()));
        Assert.Equal(jpg, await blobs.ReadAsync(parts[2]!["inlineDataRef"]!.AsObject()));
    }

    [Fact]
    public async Task Queue_and_strict_rows_are_references_before_publication_and_audit_never_contains_new_inline_bytes()
    {
        using var temp = new TempDirectory();
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var registry = new SessionRegistry(store, new EmptyChat());
        var entry = registry.Add("s");
        registry.TriggerOverride = _ => Task.CompletedTask;
        var item = QueueItem.UserText("caption") with
        {
            Parts = [new JsonObject { ["text"] = "caption" }, Image(bytes)],
        };
        await registry.Ingress.EnqueueAsync("s", item);
        var queued = entry.Snapshot().Queue.Single();
        Assert.NotNull(queued.Parts![1]["inlineDataRef"]);
        Assert.Null(queued.Parts[1]["inlineData"]);
        Assert.DoesNotContain(
            Convert.ToBase64String(bytes),
            await File.ReadAllTextAsync(store.AuthorityPath)
        );
        await registry.HostFor("s").AppendQueuedInputsAsync(SessionTurnRunner.DrainLeading(entry));
        var canonical = entry.Snapshot().History.Single();
        var image = canonical["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .Single(part => part["inlineDataRef"] is not null);
        Assert.Null(image["inlineData"]);
        Assert.NotNull(image["inlineDataRef"]);
        Assert.Equal(
            EcmaJson.Stringify(canonical),
            store.Archive.ReadMessages().Single().MessageJson
        );
        Assert.Equal(bytes, await store.Images.ReadAsync(image["inlineDataRef"]!.AsObject()));
    }

    [Fact]
    public async Task Legacy_owned_admission_materializes_only_accessed_state_and_ordinary_save_is_write_new_without_audit_rewrite()
    {
        using var temp = new TempDirectory();
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var store = new PersistentSessionAuthorityStore(temp.Path, "s");
        var message = Message("user", Image(bytes));
        message["__meta"] = new JsonObject { ["seq"] = 1, ["timestamp"] = 1 };
        var document = new JsonObject
        {
            ["version"] = 1,
            ["id"] = "s",
            ["agent"] = "main",
            ["history"] = new JsonArray(message.DeepClone()),
            ["queue"] = new JsonArray(),
            ["nextMessageSeq"] = 2,
            ["nextBlockId"] = 1,
        };
        Directory.CreateDirectory(Path.GetDirectoryName(store.AuthorityPath)!);
        var original = document.ToJsonString();
        await File.WriteAllTextAsync(store.AuthorityPath, original);
        store.Archive.WriteMessages([
            new ArchiveMessageRecord(
                "s",
                "main",
                1,
                1,
                "user",
                (JsonObject)message.DeepClone(),
                EcmaJson.Stringify(message)
            ),
        ]);
        var oldAudit = store.Archive.ReadMessages().Single().MessageJson;
        var loaded = (await store.LoadAsync("s"))!;
        Assert.NotNull(loaded.History[0]["parts"]![0]!["inlineDataRef"]);
        Assert.Equal(original, await File.ReadAllTextAsync(store.AuthorityPath));
        Assert.Equal(oldAudit, store.Archive.ReadMessages().Single().MessageJson);
        var registry = new SessionRegistry(store, new EmptyChat());
        var entry = registry.Add("s", loaded);
        await entry.SaveLane.SaveStrictAsync();
        Assert.DoesNotContain(
            Convert.ToBase64String(bytes),
            await File.ReadAllTextAsync(store.AuthorityPath)
        );
        Assert.Equal(oldAudit, store.Archive.ReadMessages().Single().MessageJson);
        var invalid = Message(
            "user",
            new JsonObject
            {
                ["inlineData"] = new JsonObject
                {
                    ["mimeType"] = "image/png",
                    ["data"] = "not base64!",
                },
            }
        );
        var prior = invalid.ToJsonString();
        await store.Images.ExternalizeMessageAsync(invalid, false);
        Assert.Equal(prior, invalid.ToJsonString());
        await Assert.ThrowsAsync<ImageInputException>(() =>
            store.Images.HydrateAsync([invalid], "responses")
        );
    }

    [Fact]
    public async Task Legacy_file_references_are_state_confined_and_failed_materialization_preserves_old_bytes_and_structure()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var stateFile = Path.Combine(
            temp.Path,
            "state",
            "sessions-blob",
            "old.images",
            "image.png"
        );
        Directory.CreateDirectory(Path.GetDirectoryName(stateFile)!);
        await File.WriteAllBytesAsync(stateFile, bytes);
        var legacy = Message(
            "user",
            new JsonObject
            {
                ["inlineDataRef"] = new JsonObject
                {
                    ["path"] = "state/sessions-blob/old.images/image.png",
                    ["mimeType"] = "image/png",
                    ["byteLength"] = bytes.Length,
                },
            }
        );
        await blobs.ExternalizeMessageAsync(legacy);
        Assert.Null(legacy["parts"]![0]!["inlineDataRef"]!["path"]);
        Assert.Equal(
            bytes,
            await blobs.ReadAsync(legacy["parts"]![0]!["inlineDataRef"]!.AsObject())
        );
        Assert.Equal(bytes, await File.ReadAllBytesAsync(stateFile));
        var outside = Path.Combine(temp.Path, "outside.png");
        await File.WriteAllBytesAsync(outside, bytes);
        var invalid = Message(
            "user",
            new JsonObject
            {
                ["inlineDataRef"] = new JsonObject
                {
                    ["path"] = outside,
                    ["mimeType"] = "image/png",
                },
            }
        );
        var prior = invalid.ToJsonString();
        await blobs.ExternalizeMessageAsync(invalid, false);
        Assert.Equal(prior, invalid.ToJsonString());
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.HydrateAsync([invalid], "responses")
        );
        File.CreateSymbolicLink(Path.Combine(temp.Path, "state", "escape.png"), outside);
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.ReadAsync(new JsonObject { ["path"] = "state/escape.png" })
        );
    }

    [Theory]
    [InlineData("responses")]
    [InlineData("completions")]
    [InlineData("anthropic")]
    public async Task Provider_only_clones_use_real_pixels_dedup_and_matching_protocol_locations(
        string protocol
    )
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var reference = await blobs.PutAsync(bytes, "image/png", "one");
        var history = new[]
        {
            Message("user", new JsonObject { ["inlineDataRef"] = reference.DeepClone() }),
            Message(
                "model",
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "a",
                        ["name"] = "read",
                        ["args"] = new JsonObject(),
                    },
                },
                new JsonObject
                {
                    ["functionCall"] = new JsonObject
                    {
                        ["id"] = "b",
                        ["name"] = "read",
                        ["args"] = new JsonObject(),
                    },
                }
            ),
            Message(
                "tool",
                Tool("a", new JsonObject { ["output"] = "A" }),
                ToolImage("a", reference)
            ),
            Message(
                "tool",
                Tool("b", new JsonObject { ["output"] = "B" }),
                ToolImage("b", reference)
            ),
            Message("user", new JsonObject { ["text"] = "next" }),
        };
        var original = string.Join('\n', history.Select(message => message.ToJsonString()));
        var hydrated = await blobs.HydrateAsync(history, protocol);
        Assert.Equal(
            original,
            string.Join('\n', history.Select(message => message.ToJsonString()))
        );
        Assert.All(
            hydrated.Skip(2).Take(2),
            message => Assert.Null(message["parts"]![1]!["inlineData"])
        );
        JsonArray wire =
            protocol == "responses" ? ResponsesRequestSerializer.ConvertHistory(hydrated, "m")
            : protocol == "completions"
                ? CompletionsRequestSerializer.ConvertHistory(hydrated, "m", "reasoning_content")
            : AnthropicRequestSerializer.ConvertHistory(hydrated, new Uri("http://localhost"));
        Assert.Equal(3, wire.ToJsonString().Split("[IMAGE: id=").Length - 1);
        Assert.Equal(1, wire.ToJsonString().Split(Convert.ToBase64String(bytes)).Length - 1);
        var unique = await blobs.PutAsync(
            ImageCodecTests.Raster(SKEncodedImageFormat.Jpeg),
            "image/jpeg",
            "different"
        );
        var tools = new[]
        {
            Message(
                "tool",
                Tool("a", new JsonObject { ["output"] = "A" }),
                ToolImage("a", reference)
            ),
            Message("tool", Tool("b", new JsonObject { ["output"] = "B" }), ToolImage("b", unique)),
        };
        var different = await blobs.HydrateAsync(tools, protocol);
        wire =
            protocol == "responses" ? ResponsesRequestSerializer.ConvertHistory(different, "m")
            : protocol == "completions"
                ? CompletionsRequestSerializer.ConvertHistory(different, "m", "reasoning_content")
            : AnthropicRequestSerializer.ConvertHistory(different, new Uri("http://localhost"));
        if (protocol == "responses")
            Assert.All(
                wire,
                item =>
                    Assert.Equal(
                        "input_image",
                        item!["output"]!.AsArray().Last()!["type"]!.ToString()
                    )
            );
        if (protocol == "completions")
        {
            Assert.Equal(
                new[] { "tool", "tool", "user" },
                wire.Select(item => item!["role"]!.ToString())
            );
            Assert.Equal(
                2,
                wire[2]!["content"]!
                    .AsArray()
                    .Count(item => item?["type"]?.ToString() == "image_url")
            );
        }
        if (protocol == "anthropic")
        {
            var results = wire[0]!["content"]!.AsArray();
            Assert.Equal(2, results.Count);
            Assert.All(
                results,
                item =>
                    Assert.Equal("image", item!["content"]!.AsArray().Last()!["type"]!.ToString())
            );
        }
    }

    [Fact]
    public async Task Missing_or_corrupt_original_is_local_preparation_not_network_retry_failover_or_health()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var reference = await blobs.PutAsync(
            ImageCodecTests.Raster(SKEncodedImageFormat.Png),
            "image/png",
            "one"
        );
        var catalog = HostModels.Parse(
            JsonNode
                .Parse(
                    """{"default":"route","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost/a","models":["m"]},"b":{"providerType":"anthropic","baseUrl":"http://localhost/b","models":["m"]},"route":{"providerType":"failover","targets":["a","b"],"failureThreshold":1}}}"""
                )!
                .AsObject(),
            new JsonObject()
        );
        var count = 0;
        var events = 0;
        var routing = new ModelRouting();
        using var client = new HttpClient(
            new Handler(
                (_, _) =>
                {
                    count++;
                    throw new InvalidOperationException("must not send");
                }
            )
        );
        var owner = new ModelRequestOwner(
            client,
            new(new Uri("http://localhost"), "m", "a/m", "", "", 100),
            routing,
            (_, _) => Task.CompletedTask,
            images: blobs
        );
        var message = Message("user", new JsonObject { ["inlineDataRef"] = reference.DeepClone() });
        foreach (var missing in new[] { false, true })
        {
            if (missing)
                File.Delete(blobs.ResolveBlob(reference["blobId"]!.ToString()));
            else
                await File.WriteAllBytesAsync(
                    blobs.ResolveBlob(reference["blobId"]!.ToString()),
                    "corrupt"u8.ToArray()
                );
            await Assert.ThrowsAsync<ModelPreparationException>(() =>
                owner.RequestAsync(
                    "s",
                    catalog,
                    "route",
                    null,
                    "cache",
                    "turn",
                    [message],
                    (_, _) => Task.FromResult("prompt"),
                    _ =>
                    {
                        events++;
                        return Task.FromResult(false);
                    },
                    null,
                    null,
                    null,
                    CancellationToken.None
                )
            );
        }
        Assert.Equal(0, count);
        Assert.Equal(0, events);
        Assert.Equal(
            "a/m",
            routing.Select(routing.Begin("route", catalog.Resolve("route")), "cache").TargetKey
        );
    }

    [Fact]
    public void Every_transport_clone_removes_legacy_bytes_paths_reserved_helpers_and_untrusted_URL_without_mutating_data()
    {
        var node = Message(
            "tool",
            Tool(
                "call",
                new JsonObject
                {
                    ["inlineData"] = new JsonObject
                    {
                        ["mimeType"] = "image/png",
                        ["data"] = "PRIVATEIMAGE",
                    },
                    ["business"] = new JsonObject
                    {
                        ["data"] = "opaque",
                        ["metadata"] = new JsonObject { ["image"] = true },
                    },
                }
            ),
            new JsonObject
            {
                ["inlineDataRef"] = new JsonObject
                {
                    ["blobId"] = new string('a', 64) + ".png",
                    ["path"] = "private legacy path",
                    ["apiPath"] = "https://untrusted.invalid",
                    ["mimeType"] = "image/png",
                },
                ["__providerImageDeduplicated"] = true,
            }
        );
        var old = node.ToJsonString();
        var wrapper = new JsonObject
        {
            ["history"] = new JsonArray(node.DeepClone()),
            ["queue"] = new JsonArray(new JsonObject { ["message"] = node.DeepClone() }),
            ["messageJson"] = old,
        };
        var projected = ImageTransport.Project(wrapper)!.ToJsonString();
        Assert.DoesNotContain("PRIVATEIMAGE", projected);
        Assert.DoesNotContain("private legacy path", projected);
        Assert.DoesNotContain("untrusted.invalid", projected);
        Assert.DoesNotContain("__providerImage", projected);
        Assert.Contains("/blobs/", projected);
        Assert.Contains("opaque", projected);
        Assert.Equal(old, node.ToJsonString());
    }

    [Theory]
    [InlineData("responses", "b")]
    [InlineData("completions", "b")]
    [InlineData("anthropic", "a")]
    public async Task Dedup_uses_actual_selected_protocol_tool_emission_order_not_raw_part_order(
        string protocol,
        string first
    )
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var reference = await blobs.PutAsync(
            ImageCodecTests.Raster(SKEncodedImageFormat.Png),
            "image/png",
            "one"
        );
        var row = Message(
            "tool",
            ToolImage("b", reference),
            ToolImage("a", reference),
            Tool("a", new JsonObject { ["output"] = "A" }),
            Tool("b", new JsonObject { ["output"] = "B" })
        );
        var hydrated = (await blobs.HydrateAsync([row], protocol))[0]["parts"]!
            .AsArray()
            .OfType<JsonObject>()
            .Where(part => part["inlineDataRef"] is not null)
            .ToArray();
        Assert.NotNull(
            hydrated.Single(part => part["toolUseId"]!.ToString() == first)["inlineData"]
        );
        Assert.Null(hydrated.Single(part => part["toolUseId"]!.ToString() != first)["inlineData"]);
        Assert.DoesNotContain("__providerImage", row.ToJsonString());
        Assert.DoesNotContain("__providerImage", hydrated[0].Parent!.ToJsonString());
    }

    [Fact]
    public async Task Recognized_tool_reference_carriers_verify_existing_safe_raster_blobs_and_never_trust_posted_path_or_URL()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var reference = await blobs.PutAsync(
            ImageCodecTests.Raster(SKEncodedImageFormat.Png),
            "image/png",
            "old"
        );
        reference["apiPath"] = "https://untrusted.invalid";
        reference["path"] = "untrusted old file";
        var row = Message(
            "tool",
            Tool(
                "call",
                new JsonObject
                {
                    ["imageParts"] = new JsonArray(
                        new JsonObject { ["inlineDataRef"] = reference.DeepClone() }
                    ),
                    ["data"] = "opaque",
                }
            )
        );
        await blobs.ExternalizeMessageAsync(row);
        var parts = row["parts"]!.AsArray();
        Assert.Equal(2, parts.Count);
        Assert.Null(parts[0]!["functionResponse"]!["response"]!["imageParts"]);
        Assert.Equal("opaque", parts[0]!["functionResponse"]!["response"]!["data"]!.ToString());
        Assert.Equal("call#1", parts[1]!["imageMeta"]!["imageId"]!.ToString());
        Assert.Null(parts[1]!["inlineDataRef"]!["path"]);
        Assert.Null(parts[1]!["inlineDataRef"]!["apiPath"]);
        var business = Message(
            "tool",
            Tool(
                "call",
                new JsonObject
                {
                    ["imageParts"] = new JsonArray(new JsonObject { ["data"] = "opaque business" }),
                }
            )
        );
        var exact = business.ToJsonString();
        await blobs.ExternalizeMessageAsync(business);
        Assert.Equal(exact, business.ToJsonString());
    }

    [Fact]
    public void Diagnostic_bodies_redact_actual_image_payloads_without_changing_plain_error_classification()
    {
        var body =
            "{\"error\":{\"message\":\"bad image data:image/png;base64,SECRETIMAGE==\",\"input\":{\"mimeType\":\"image/png\",\"data\":\"SECRETIMAGE\"}}}";
        var failure = ModelAttemptFailure.Http(400, body);
        Assert.DoesNotContain("SECRETIMAGE", failure.Message);
        Assert.False(failure.Retryable);
        Assert.False(failure.Countable);
        Assert.Equal((true, true), ModelAttemptFailure.ClassifyHttp(400, "model not found"));
    }

    [Fact]
    public void Image_estimates_count_references_and_nested_actual_carriers_without_counting_payload_bytes()
    {
        var tiny = Message("user", Image([1, 2]));
        var large = Message("user", Image(new byte[100_000]));
        Assert.Equal((0, 1), ImageTokenEstimate.Message(tiny));
        Assert.Equal(ImageTokenEstimate.Message(tiny), ImageTokenEstimate.Message(large));
        var reference = Message(
            "user",
            new JsonObject
            {
                ["inlineDataRef"] = new JsonObject
                {
                    ["mimeType"] = "image/png",
                    ["blobId"] = new string('a', 64) + ".png",
                },
            }
        );
        Assert.Equal((0, 1), ImageTokenEstimate.Message(reference));
        var nested = Tool(
            "call",
            new JsonObject { ["inlineData"] = Image(new byte[100_000])["inlineData"]!.DeepClone() }
        );
        var summary = ImageTokenEstimate.Part(nested);
        Assert.Equal(1, summary.Images);
        Assert.InRange(summary.Tokens, 1, 100);
    }

    [Fact]
    public async Task Accessed_tree_materializes_real_deferred_inputs_but_does_not_reinterpret_opaque_business_parts()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var image = Image(ImageCodecTests.Raster(SKEncodedImageFormat.Png));
        var business = new JsonObject
        {
            ["parts"] = new JsonArray(image.DeepClone()),
            ["data"] = "business",
        };
        var exact = business.ToJsonString();
        await blobs.ExternalizeTreeAsync(business);
        Assert.Equal(exact, business.ToJsonString());
        Assert.False(Directory.Exists(blobs.BlobRoot));
        var metadata = new JsonObject
        {
            ["wait"] = new JsonObject
            {
                ["deferred"] = new JsonArray(
                    new JsonObject
                    {
                        ["type"] = "user",
                        ["parts"] = new JsonArray(image.DeepClone()),
                    }
                ),
            },
        };
        await blobs.ExternalizeTreeAsync(metadata);
        Assert.NotNull(metadata["wait"]!["deferred"]![0]!["parts"]![0]!["inlineDataRef"]);
    }

    [Theory]
    [InlineData("jpeg", true)]
    [InlineData("webp", true)]
    [InlineData("JPEG", false)]
    [InlineData(" jpeg ", false)]
    [InlineData(null, false)]
    public void Provider_output_configuration_keeps_exact_Source_values_and_missing_default(
        string? format,
        bool allowed
    )
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        var path = Path.Combine(temp.Path, "state", "config.yaml");
        File.WriteAllText(
            path,
            "llm: { providerImageOutputFormat: "
                + System.Text.Json.JsonSerializer.Serialize(format)
                + " }"
        );
        if (allowed)
            Assert.Equal(format, new ModelConfiguration(temp.Path).ProviderImageOutputFormat);
        else
            Assert.Throws<InvalidDataException>(() => new ModelConfiguration(temp.Path));
        File.WriteAllText(path, "llm: {}\n");
        Assert.Equal("webp", new ModelConfiguration(temp.Path).ProviderImageOutputFormat);
    }

    [Fact]
    public async Task Large_actual_image_carriers_survive_the_text_guard_and_never_become_text_or_output_file_bytes()
    {
        using var temp = new TempDirectory();
        var blobs = new ImageBlobStore(temp.Path);
        var bytes = ImageCodecTests.Raster(SKEncodedImageFormat.Png);
        var image = new JsonObject
        {
            ["mimeType"] = "image/png",
            ["data"] = Convert.ToBase64String(bytes) + new string('\n', 50000),
        };
        var response = new JsonObject
        {
            ["business"] = new JsonObject { ["data"] = "opaque" },
            ["inlineDataItems"] = new JsonArray(image),
        };
        var guarded = await Foxwarm.Tools.ToolOutputGuard.GuardAsync(response, temp.Path, "large");
        Assert.NotNull(guarded!["inlineDataItems"]);
        Assert.False(Directory.Exists(Path.Combine(temp.Path, ".temp", "tool-output")));
        var message = Message(
            "tool",
            new JsonObject
            {
                ["functionResponse"] = new JsonObject
                {
                    ["tool_use_id"] = "large",
                    ["response"] = guarded,
                },
            }
        );
        await blobs.ExternalizeMessageAsync(message);
        Assert.Equal(
            "opaque",
            message["parts"]![0]!["functionResponse"]!["response"]!["business"]![
                "data"
            ]!.GetValue<string>()
        );
        Assert.DoesNotContain(Convert.ToBase64String(bytes), message.ToJsonString());
        Assert.Equal(
            bytes,
            await blobs.ReadAsync(message["parts"]![1]!["inlineDataRef"]!.AsObject())
        );
        var largeText = new JsonObject
        {
            ["output"] = new string('x', 50000),
            ["inlineData"] = image.DeepClone(),
        };
        var trimmed = await Foxwarm.Tools.ToolOutputGuard.GuardAsync(
            largeText,
            temp.Path,
            "large-text"
        );
        Assert.NotNull(trimmed!["inlineData"]);
        Assert.True(trimmed["outputTruncated"]!.GetValue<bool>());
        Assert.DoesNotContain(
            Convert.ToBase64String(bytes),
            await File.ReadAllTextAsync(trimmed["outputFullPath"]!.GetValue<string>())
        );
        await Assert.ThrowsAsync<ImageInputException>(() =>
            blobs.ExternalizeMessageAsync(
                Message(
                    "user",
                    new JsonObject
                    {
                        ["inlineData"] = new JsonObject
                        {
                            ["mimeType"] = "image/png",
                            ["data"] = "",
                        },
                    }
                )
            )
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

    private sealed class Handler(
        Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send
    ) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        ) => send(request, token);
    }
}
