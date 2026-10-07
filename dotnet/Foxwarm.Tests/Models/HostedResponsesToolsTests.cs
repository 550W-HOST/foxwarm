using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Models;

namespace Foxwarm.Tests.Models;

public sealed class HostedResponsesToolsTests
{
    [Fact]
    public void Builds_source_shaped_hosted_tools_and_respects_partial_zero()
    {
        var search = HostedResponsesTools.BuildWebSearchTool(
            new JsonObject
            {
                ["enabled"] = true,
                ["toolChoice"] = "required",
                ["searchContextSize"] = "high",
                ["allowedDomains"] = new JsonArray("example.test"),
                ["userLocation"] = new JsonObject { ["country"] = "US" },
            }
        );
        Assert.Equal("web_search", search!["type"]!.GetValue<string>());
        Assert.Equal("high", search["search_context_size"]!.GetValue<string>());
        Assert.Equal("example.test", search["filters"]!["allowed_domains"]![0]!.GetValue<string>());

        var options = new ResponsesClientOptions(
            new Uri("http://localhost/v1"),
            "wire",
            "openai/wire",
            "",
            "system",
            1000
        )
        {
            WebSearch = new JsonObject { ["enabled"] = true },
            ImageGeneration = new JsonObject { ["enabled"] = true, ["outputFormat"] = "png" },
        };
        var body = ResponsesRequestPlan.Build([], options);
        var tools = Assert.IsType<JsonArray>(body["tools"]);
        Assert.Contains(
            tools.OfType<JsonObject>(),
            item => item["type"]?.GetValue<string>() == "web_search"
        );
        var image = Assert.Single(
            tools.OfType<JsonObject>(),
            item => item["type"]?.GetValue<string>() == "image_generation"
        );
        Assert.Equal(0, image["partial_images"]!.GetValue<int>());
        Assert.Equal("png", image["output_format"]!.GetValue<string>());
    }

    [Fact]
    public async Task Externalizes_completed_image_and_rejects_bad_or_mismatched_items()
    {
        using var temp = new TempDirectory();
        var store = new ImageBlobStore(temp.Path);
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        );
        var output = new JsonArray(
            new JsonObject
            {
                ["type"] = "image_generation_call",
                ["id"] = "call/png-1",
                ["status"] = "completed",
                ["output_format"] = "png",
                ["result"] = Convert.ToBase64String(png),
                ["id"] = "é/call_png-1",
                ["revised_prompt"] = new string('x', 2105),
                ["unexpected"] = "not-persisted",
            },
            new JsonObject
            {
                ["type"] = "image_generation_call",
                ["id"] = "bad",
                ["status"] = "completed",
                ["result"] = "%%%",
            },
            new JsonObject
            {
                ["type"] = "image_generation_call",
                ["id"] = "wrong-mime",
                ["status"] = "completed",
                ["output_format"] = "jpeg",
                ["result"] = Convert.ToBase64String(png),
            },
            new JsonObject
            {
                ["type"] = "image_generation_call",
                ["id"] = "unicode-space",
                ["status"] = "completed",
                ["result"] = Convert.ToBase64String(png).Insert(4, "\u00a0"),
            }
        );
        var normalized = await HostedResponsesTools.ExternalizeAsync(
            output,
            store,
            "openai/wire",
            default
        );
        Assert.Equal(1, normalized.SuccessfulCount);
        Assert.Equal(3, normalized.Failures.Count);
        var part = normalized.Parts[0];
        Assert.Equal("generated", part["imageMeta"]!["origin"]!.GetValue<string>());
        Assert.Equal("ig_call_png-1", part["imageMeta"]!["imageId"]!.GetValue<string>());
        Assert.NotNull(part["inlineDataRef"]);
        var metadata = part["providerMeta"]!["openaiResponses"]!["outputItem"]!.AsObject();
        Assert.Null(metadata["unexpected"]);
        Assert.Equal(2000, metadata["revised_prompt"]!.GetValue<string>().Length);

        var history = new[]
        {
            new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(part) },
        };
        var replay = ResponsesRequestSerializer.ConvertHistoryWithImages(
            history,
            "openai/wire",
            store
        );
        var replayItem = Assert.Single(
            replay,
            node => node?["type"]?.GetValue<string>() == "image_generation_call"
        );
        Assert.Equal(
            Convert.ToBase64String(png),
            Assert.IsAssignableFrom<JsonValue>(replayItem!["result"]).GetValue<string>()
        );
        var crossModel = ResponsesRequestSerializer.ConvertHistoryWithImages(
            history,
            "openai/other",
            store
        );
        Assert.DoesNotContain(
            crossModel,
            node => node?["type"]?.GetValue<string>() == "image_generation_call"
        );
        Assert.Contains(crossModel, node => node?["type"]?.GetValue<string>() == "message");
    }

    [Fact]
    public void Converts_web_search_as_provider_owned_metadata_and_replays_only_same_concrete()
    {
        var response = new JsonObject
        {
            ["output"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "web_search_call",
                    ["id"] = "search-1",
                    ["status"] = "completed",
                    ["action"] = new JsonObject { ["query"] = "foxwarm" },
                },
                new JsonObject
                {
                    ["type"] = "message",
                    ["role"] = "assistant",
                    ["content"] = new JsonArray(
                        new JsonObject { ["type"] = "output_text", ["text"] = "done" }
                    ),
                }
            ),
        };
        var assistant = ResponsesCanonicalConverter.ConvertAssistant(
            response,
            "openai/wire",
            1000,
            1
        )!;
        var searchPart = Assert.Single(
            assistant["parts"]!.AsArray(),
            node => node?["providerMeta"]?["openaiResponses"]?["outputItem"] is not null
        );
        var same = ResponsesRequestSerializer.ConvertHistory([assistant], "openai/wire");
        Assert.Contains(same, node => node?["type"]?.GetValue<string>() == "web_search_call");
        var other = ResponsesRequestSerializer.ConvertHistory([assistant], "openai/other");
        Assert.DoesNotContain(
            other,
            node => node?["type"]?.GetValue<string>() == "web_search_call"
        );
        Assert.Contains(other, node => node?["type"]?.GetValue<string>() == "message");
    }

    [Fact]
    public async Task Http_responses_service_externalizes_generated_image_before_returning_result()
    {
        using var temp = new TempDirectory();
        var store = new ImageBlobStore(temp.Path);
        var png = Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        );
        var response = new JsonObject
        {
            ["output"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "image_generation_call",
                    ["id"] = "call-http",
                    ["status"] = "completed",
                    ["output_format"] = "png",
                    ["result"] = Convert.ToBase64String(png),
                }
            ),
        };
        var handler = new SingleResponseHandler(response);
        using var http = new HttpClient(handler);
        var options = new ResponsesClientOptions(
            new Uri("http://localhost/v1"),
            "wire",
            "openai/wire",
            "",
            "system",
            1000
        )
        {
            ImageGeneration = new JsonObject { ["enabled"] = true },
            Images = store,
            DisallowEmptyResponse = true,
        };
        var service = new ResponsesChatService(http, options);
        var result = await service.ChatAsync("session", [], default);
        var part = Assert.Single(result.AssistantMessage!["parts"]!.AsArray());
        Assert.Equal("generated", part!["imageMeta"]!["origin"]!.GetValue<string>());
        Assert.NotNull(part["inlineDataRef"]);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task All_generated_image_failures_are_local_nonretryable_errors()
    {
        using var temp = new TempDirectory();
        var response = new JsonObject
        {
            ["output"] = new JsonArray(
                new JsonObject
                {
                    ["type"] = "image_generation_call",
                    ["id"] = "bad",
                    ["status"] = "completed",
                    ["result"] = "%%%",
                }
            ),
        };
        using var http = new HttpClient(new SingleResponseHandler(response));
        var options = new ResponsesClientOptions(
            new Uri("http://localhost/v1"),
            "wire",
            "openai/wire",
            "",
            "system",
            1000
        )
        {
            ImageGeneration = new JsonObject { ["enabled"] = true },
            Images = new ImageBlobStore(temp.Path),
        };
        var error = await Assert.ThrowsAsync<ModelAttemptFailure>(() =>
            new ResponsesChatService(http, options).ChatAsync("session", [], default)
        );
        Assert.False(error.Retryable);
        Assert.False(error.Countable);
    }

    [Fact]
    public async Task Missing_generated_blob_fails_before_provider_send()
    {
        using var temp = new TempDirectory();
        var handler = new SingleResponseHandler(new JsonObject { ["output"] = new JsonArray() });
        using var http = new HttpClient(handler);
        var options = new ResponsesClientOptions(
            new Uri("http://localhost/v1"),
            "wire",
            "openai/wire",
            "",
            "system",
            1000
        )
        {
            Images = new ImageBlobStore(temp.Path),
        };
        var history = new[]
        {
            new JsonObject
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["inlineDataRef"] = new JsonObject
                        {
                            ["blobId"] = new string('f', 64) + ".png",
                            ["imageId"] = "missing-generated",
                            ["mimeType"] = "image/png",
                            ["byteLength"] = 95,
                            ["sha256"] = new string('f', 64),
                        },
                        ["imageMeta"] = new JsonObject
                        {
                            ["imageId"] = "missing-generated",
                            ["origin"] = "generated",
                            ["mimeType"] = "image/png",
                        },
                        ["providerMeta"] = new JsonObject
                        {
                            ["openaiResponses"] = new JsonObject
                            {
                                ["sourceModelId"] = "openai/wire",
                                ["outputItem"] = new JsonObject
                                {
                                    ["type"] = "image_generation_call",
                                    ["id"] = "missing-generated",
                                    ["status"] = "completed",
                                },
                            },
                        },
                    }
                ),
            },
        };
        await Assert.ThrowsAsync<ImageInputException>(() =>
            new ResponsesChatService(http, options).ChatAsync("session", history, default)
        );
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public void Image_stream_status_progress_is_known_item_only_and_never_contains_preview_bytes()
    {
        var progress = new List<ResponsesStreamProgress>();
        var accumulator = new ResponsesEventAccumulator(
            new ResponsesStreamCallbacks { OnProgress = progress.Add }
        );
        accumulator.Consume(
            new JsonObject
            {
                ["type"] = "response.output_item.added",
                ["output_index"] = 2,
                ["item"] = new JsonObject
                {
                    ["type"] = "image_generation_call",
                    ["id"] = "image-2",
                    ["status"] = "in_progress",
                },
            }
        );
        accumulator.Consume(
            new JsonObject
            {
                ["type"] = "response.image_generation_call.partial_image",
                ["output_index"] = 9,
                ["partial_image_b64"] = "preview-must-not-escape",
            }
        );
        accumulator.Consume(
            new JsonObject
            {
                ["type"] = "response.image_generation_call.generating",
                ["output_index"] = 2,
            }
        );
        accumulator.Consume(
            new JsonObject
            {
                ["type"] = "response.image_generation_call.completed",
                ["output_index"] = 2,
            }
        );
        var last = progress[^1];
        var image = Assert.Single(last.Parts!, part => part.Kind == "image-generation");
        Assert.Equal(2, image.OutputIndex);
        Assert.Equal("completed", image.Status);
        Assert.DoesNotContain(progress, update => update.Text.Contains("preview-must-not-escape"));
    }

    [Fact]
    public async Task Foreign_generated_history_skips_blob_read_and_uses_local_id_guidance()
    {
        using var temp = new TempDirectory();
        var store = new ImageBlobStore(temp.Path);
        var part = new JsonObject
        {
            ["inlineDataRef"] = new JsonObject
            {
                ["blobId"] = new string('f', 64) + ".png",
                ["imageId"] = "ig_foreign",
                ["mimeType"] = "image/png",
                ["byteLength"] = 1,
                ["sha256"] = new string('f', 64),
            },
            ["imageMeta"] = new JsonObject
            {
                ["imageId"] = "ig_foreign",
                ["origin"] = "generated",
                ["mimeType"] = "image/png",
            },
            ["providerMeta"] = new JsonObject
            {
                ["openaiResponses"] = new JsonObject
                {
                    ["sourceModelId"] = "openai/source",
                    ["outputItem"] = new JsonObject
                    {
                        ["type"] = "image_generation_call",
                        ["id"] = "foreign",
                        ["status"] = "completed",
                    },
                },
            },
        };
        var hydrated = await store.HydrateAsync(
            [new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(part) }],
            "completions",
            concreteModelId: "completions/target"
        );
        Assert.Null(hydrated[0]["parts"]![0]!["inlineData"]);
        var wire = CompletionsRequestSerializer.ConvertHistory(
            hydrated,
            "completions/target",
            "reasoning_content"
        );
        Assert.Contains(
            wire,
            node => node?["content"]?.ToJsonString().Contains("ig_foreign") == true
        );
    }

    private sealed class TempDirectory : IDisposable
    {
        internal string Path { get; } =
            System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "foxwarm-hosted-tools-" + Guid.NewGuid().ToString("N")
            );

        public TempDirectory() => Directory.CreateDirectory(Path);

        public void Dispose()
        {
            if (Directory.Exists(Path))
                Directory.Delete(Path, true);
        }
    }

    private sealed class SingleResponseHandler(JsonObject response) : HttpMessageHandler
    {
        internal int Calls { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            Calls++;
            var body =
                "data: "
                + new JsonObject
                {
                    ["type"] = "response.completed",
                    ["response"] = response,
                }.ToJsonString()
                + "\n\ndata: [DONE]\n\n";
            return Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(body, Encoding.UTF8, "text/event-stream"),
                }
            );
        }
    }
}
