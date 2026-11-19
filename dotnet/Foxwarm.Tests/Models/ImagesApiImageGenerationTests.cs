using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class ImagesApiImageGenerationTests
{
    private const string Png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    private const string OtherPng =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    private sealed record ImageCall(
        string Path,
        string? ContentType,
        string? Authorization,
        string? Extra,
        JsonObject? Json,
        Dictionary<string, string>? Fields,
        List<(string Name, string? ContentType, long Length)>? Files
    );

    private sealed class ImagesEndpoint(Func<ImageCall, (int Status, JsonObject Body)> respond)
    {
        internal List<ImageCall> Calls { get; } = [];

        internal async Task Handle(HttpContext http)
        {
            var path = http.Request.Path.Value!;
            var contentType = http.Request.ContentType;
            JsonObject? json = null;
            Dictionary<string, string>? fields = null;
            List<(string, string?, long)>? files = null;
            if (http.Request.HasFormContentType)
            {
                var form = await http.Request.ReadFormAsync();
                fields = form.ToDictionary(pair => pair.Key, pair => pair.Value.ToString());
                files = form
                    .Files.Select(file => (file.Name, (string?)file.ContentType, file.Length))
                    .ToList();
            }
            else
                json = (await JsonNode.ParseAsync(http.Request.Body))!.AsObject();
            var call = new ImageCall(
                path,
                contentType,
                http.Request.Headers.Authorization.ToString(),
                http.Request.Headers["X-Extra"].ToString(),
                json,
                fields,
                files
            );
            lock (Calls)
                Calls.Add(call);
            var (status, body) = respond(call);
            http.Response.StatusCode = status;
            http.Response.ContentType = "application/json";
            await http.Response.WriteAsync(body.ToJsonString());
        }
    }

    private static JsonObject ImageSettings(
        string? api = "images",
        string? model = "gpt-image-2",
        string mode = "separate"
    )
    {
        var settings = new JsonObject
        {
            ["enabled"] = true,
            ["mode"] = mode,
            ["size"] = "1536x1024",
            ["quality"] = "high",
            ["background"] = "opaque",
            ["outputFormat"] = "png",
            ["outputCompression"] = 80,
            ["action"] = "generate",
        };
        if (api is not null)
            settings["api"] = api;
        if (model is not null)
            settings["model"] = model;
        return settings;
    }

    private static HostModels Catalog(
        Uri uri,
        bool websocket,
        JsonObject? provider = null,
        JsonNode? model = null
    )
    {
        var config = new JsonObject
        {
            ["default"] = "p/m",
            ["providers"] = new JsonObject
            {
                ["p"] = new JsonObject
                {
                    ["providerType"] = websocket ? "openai-ws" : "openai-responses",
                    ["baseUrl"] = uri.ToString(),
                    ["apiKey"] = "test-provider-key",
                    ["extraHeaders"] = new JsonObject { ["X-Extra"] = "relay-header" },
                    ["models"] = new JsonArray(Model(model)),
                    ["imageGeneration"] = provider ?? ImageSettings(),
                },
            },
        };
        return HostModels.Parse(config, new JsonObject());
    }

    private static JsonObject Model(JsonNode? imageGeneration)
    {
        var model = new JsonObject
        {
            ["id"] = "m",
            ["pricing"] = new JsonObject
            {
                ["cached"] = 1,
                ["input"] = 2,
                ["output"] = 3,
            },
        };
        if (imageGeneration is not null)
            model["imageGeneration"] = imageGeneration.DeepClone();
        return model;
    }

    private static JsonObject Complete(params JsonObject[] output) =>
        new()
        {
            ["type"] = "response.completed",
            ["response"] = new JsonObject
            {
                ["id"] = "resp_" + Guid.NewGuid().ToString("N"),
                ["status"] = "completed",
                ["output"] = new JsonArray(output.Select(item => (JsonNode?)item).ToArray()),
            },
        };

    private static JsonObject ImageResult(string base64 = Png) =>
        new()
        {
            ["created"] = 1,
            ["output_format"] = "png",
            ["data"] = new JsonArray(new JsonObject { ["b64_json"] = base64 }),
            ["usage"] = new JsonObject
            {
                ["input_tokens"] = 50,
                ["output_tokens"] = 4160,
                ["total_tokens"] = 4210,
                ["input_tokens_details"] = new JsonObject
                {
                    ["text_tokens"] = 40,
                    ["image_tokens"] = 10,
                },
            },
        };

    private sealed record TurnRun(
        SessionManager Manager,
        SessionOwner Owner,
        StreamingModelPeer Peer,
        ImagesEndpoint Images,
        TempDirectory Temp
    ) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            await Manager.DisposeAsync();
            await Peer.DisposeAsync();
            Temp.Dispose();
        }
    }

    // One normal turn: the model calls generate_image, the turn host runs it, and the next
    // conversation request receives the tool result that the follow-up assertion inspects.
    private static async Task<TurnRun> RunTurnAsync(
        bool websocket,
        string arguments,
        Func<ImageCall, (int, JsonObject)> images,
        Action<JsonObject> followUp,
        bool referenceImages = false,
        Func<Uri, HostModels>? catalog = null
    )
    {
        var temp = new TempDirectory();
        var endpoint = new ImagesEndpoint(images);
        var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                var body = context.Request;
                Assert.DoesNotContain(
                    body["tools"]!.AsArray(),
                    tool => tool?["type"]?.GetValue<string>() == "image_generation"
                );
                if (number == 1)
                {
                    Assert.Contains(
                        body["tools"]!.AsArray(),
                        tool => tool?["name"]?.GetValue<string>() == "generate_image"
                    );
                    await context.Send(
                        Complete(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["id"] = "fc_image",
                                ["call_id"] = "call_image",
                                ["name"] = "generate_image",
                                ["arguments"] = arguments,
                            }
                        )
                    );
                    return;
                }
                Assert.Equal(2, number);
                followUp(body);
                await context.Send(
                    Complete(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "output_text", ["text"] = "Done." }
                            ),
                        }
                    )
                );
            },
            endpoint.Handle
        );
        var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.Uri, "m", "p/m", "", "", 1000),
            catalog?.Invoke(peer.Uri) ?? Catalog(peer.Uri, websocket)
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "images-api", null, null);
        if (referenceImages)
        {
            var parts = new JsonArray(new JsonObject { ["text"] = "two references" });
            foreach (var (id, data) in new[] { ("first-image", Png), ("second-image", OtherPng) })
            {
                var reference = await manager.Images.PutAsync(
                    Convert.FromBase64String(data),
                    "image/png",
                    id
                );
                parts.Add(
                    new JsonObject
                    {
                        ["inlineDataRef"] = reference,
                        ["imageMeta"] = new JsonObject { ["imageId"] = id },
                    }
                );
            }
            await ForkClearLifecycleTests.AppendAsync(
                owner,
                new JsonObject { ["role"] = "user", ["parts"] = parts }
            );
        }
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Make an image"));
        await owner.DrainForegroundAsync();
        Assert.Equal(2, peer.Requests.Count);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        return new TurnRun(manager, owner, peer, endpoint, temp);
    }

    private static JsonObject ToolResponse(SessionOwner owner) =>
        Assert.Single(
            owner
                .History()
                .SelectMany(row => row["parts"]!.AsArray())
                .Select(part => part?["functionResponse"])
                .OfType<JsonObject>()
        )!;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Generation_posts_json_over_http_and_returns_an_owned_image(bool websocket)
    {
        await using var run = await RunTurnAsync(
            websocket,
            "{\"prompt\":\"Draw a blue circle\"}",
            _ => (200, ImageResult()),
            body => Assert.Contains("Generated one image.", body.ToJsonString())
        );
        var call = Assert.Single(run.Images.Calls);
        Assert.Equal("/images/generations", call.Path);
        Assert.StartsWith("application/json", call.ContentType);
        Assert.Equal("Bearer test-provider-key", call.Authorization);
        Assert.Equal("relay-header", call.Extra);
        var json = call.Json!;
        Assert.Equal("gpt-image-2", json["model"]!.GetValue<string>());
        Assert.Equal("Draw a blue circle", json["prompt"]!.GetValue<string>());
        Assert.Equal("1536x1024", json["size"]!.GetValue<string>());
        Assert.Equal("high", json["quality"]!.GetValue<string>());
        Assert.Equal("opaque", json["background"]!.GetValue<string>());
        Assert.Equal("png", json["output_format"]!.GetValue<string>());
        Assert.Equal(80, json["output_compression"]!.GetValue<int>());
        foreach (var absent in new[] { "action", "response_format", "tools", "input", "stream" })
            Assert.Null(json[absent]);

        var parts = run.Owner.History().SelectMany(row => row["parts"]!.AsArray()).ToArray();
        Assert.Contains(
            parts,
            part =>
                part?["toolUseId"]?.GetValue<string>() == "call_image"
                && part["inlineDataRef"] is not null
        );
        Assert.Null(ToolResponse(run.Owner)["response"]!["error"]);
        Assert.DoesNotContain(
            Png,
            string.Concat(run.Owner.History().Select(row => row.ToJsonString()))
        );

        var journal = Assert.Single(
            await run.Manager.Journal.ListAsync(run.Owner.Id, "image-generation", null, null, 10)
        );
        var record = (
            await run.Manager.Journal.ReconstructAsync(journal!["requestId"]!.GetValue<string>())
        ).ToJsonString();
        Assert.Contains("inlineDataRef", record);
        Assert.Contains("\"outputTokens\":4160", record);
        Assert.DoesNotContain(Png, record);
        // Image tokens are recorded without the conversation model's prices.
        Assert.DoesNotContain("\"cost\"", record);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Reference_images_post_multipart_edits_with_every_image(bool websocket)
    {
        await using var run = await RunTurnAsync(
            websocket,
            "{\"prompt\":\"Combine them\",\"imageIds\":[\"first-image\",\"second-image\"]}",
            _ => (200, ImageResult()),
            body => Assert.Contains("Generated one image.", body.ToJsonString()),
            referenceImages: true
        );
        var call = Assert.Single(run.Images.Calls);
        Assert.Equal("/images/edits", call.Path);
        Assert.StartsWith("multipart/form-data", call.ContentType);
        Assert.Equal("Bearer test-provider-key", call.Authorization);
        Assert.Equal("relay-header", call.Extra);
        Assert.Equal("gpt-image-2", call.Fields!["model"]);
        Assert.Equal("Combine them", call.Fields["prompt"]);
        Assert.Equal("1536x1024", call.Fields["size"]);
        Assert.Equal("png", call.Fields["output_format"]);
        Assert.Equal("80", call.Fields["output_compression"]);
        Assert.False(call.Fields.ContainsKey("action"));
        Assert.Equal(2, call.Files!.Count);
        Assert.All(
            call.Files,
            file =>
            {
                Assert.Equal("image[]", file.Name);
                Assert.StartsWith("image/", file.ContentType);
                Assert.True(file.Length > 0);
            }
        );
        Assert.Null(ToolResponse(run.Owner)["response"]!["error"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Provider_error_becomes_a_persisted_tool_error_and_the_turn_continues(
        bool websocket
    )
    {
        const string providerMessage =
            "Hosted image_generation is not available on this route; try another model.";
        await using var run = await RunTurnAsync(
            websocket,
            "{\"prompt\":\"Draw\"}",
            _ =>
                (
                    400,
                    new JsonObject
                    {
                        ["error"] = new JsonObject
                        {
                            ["message"] = providerMessage,
                            ["type"] = "invalid_request_error",
                        },
                    }
                ),
            body =>
            {
                var text = body.ToJsonString();
                Assert.Contains("function_call_output", text);
                Assert.Contains("Image generation failed: Images API HTTP 400: " + providerMessage, text);
            }
        );
        Assert.Single(run.Images.Calls);
        var response = ToolResponse(run.Owner);
        Assert.Equal("call_image", response["tool_use_id"]!.GetValue<string>());
        Assert.Contains(
            providerMessage,
            response["response"]!.FailureMessage()!
        );
        Assert.Contains(
            run.Owner.History(),
            row => row["role"]!.GetValue<string>() == "tool"
        );
        var journal = Assert.Single(
            await run.Manager.Journal.ListAsync(run.Owner.Id, "image-generation", null, null, 10)
        );
        var record = (
            await run.Manager.Journal.ReconstructAsync(journal!["requestId"]!.GetValue<string>())
        ).ToJsonString();
        Assert.Contains("http-error", record);
        Assert.DoesNotContain("test-provider-key", record);
    }

    [Fact]
    public async Task Url_only_results_are_rejected_as_a_tool_error()
    {
        await using var run = await RunTurnAsync(
            false,
            "{\"prompt\":\"Draw\"}",
            _ =>
                (
                    200,
                    new JsonObject
                    {
                        ["created"] = 1,
                        ["data"] = new JsonArray(
                            new JsonObject { ["url"] = "https://images.invalid/a.png" }
                        ),
                    }
                ),
            body => Assert.Contains("b64_json", body.ToJsonString())
        );
        Assert.Single(run.Images.Calls);
        Assert.NotNull(ToolResponse(run.Owner)["response"]!["error"]);
    }

    // Regression: a failed separate Responses image request (purpose image-generation, one
    // attempt) used to escape tool dispatch, end the turn and leave the call unanswered.
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failed_responses_image_request_persists_a_tool_error_and_continues(
        bool websocket
    )
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                var body = context.Request;
                if (number == 1)
                {
                    await context.Send(
                        Complete(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["id"] = "fc_image",
                                ["call_id"] = "call_image",
                                ["name"] = "generate_image",
                                ["arguments"] = "{\"prompt\":\"Draw\"}",
                            }
                        )
                    );
                    return;
                }
                if (number == 2)
                {
                    Assert.Equal(
                        "image_generation",
                        body["tool_choice"]!["type"]!.GetValue<string>()
                    );
                    await context.Send(
                        new JsonObject
                        {
                            ["type"] = "response.failed",
                            ["response"] = new JsonObject
                            {
                                ["id"] = "failed-image",
                                ["status"] = "failed",
                                ["error"] = new JsonObject
                                {
                                    ["code"] = "invalid_request_error",
                                    ["message"] = "Hosted image_generation cannot be forced here.",
                                },
                            },
                        }
                    );
                    return;
                }
                Assert.Equal(3, number);
                var text = body.ToJsonString();
                Assert.Contains("function_call_output", text);
                Assert.Contains("Image generation failed", text);
                await context.Send(
                    Complete(
                        new JsonObject
                        {
                            ["type"] = "message",
                            ["role"] = "assistant",
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "output_text", ["text"] = "Done." }
                            ),
                        }
                    )
                );
            }
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.Uri, "m", "p/m", "", "", 1000),
            Catalog(peer.Uri, websocket, ImageSettings(api: null, model: null))
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "image-failure", null, null);
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Draw"));
        await owner.DrainForegroundAsync();
        Assert.Equal(3, peer.Requests.Count);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var response = ToolResponse(owner);
        Assert.Equal("call_image", response["tool_use_id"]!.GetValue<string>());
        Assert.Contains(
            "Image generation failed",
            response["response"]!.FailureMessage()!
        );
        Assert.Equal(
            "Done.",
            owner.History().Last()["parts"]![0]!["text"]!.GetValue<string>()
        );
    }

    [Fact]
    public void Configuration_requires_separate_mode_and_an_image_model_after_inheritance()
    {
        var uri = new Uri("http://localhost");
        InvalidDataException Fails(JsonObject provider, JsonNode? model = null) =>
            Assert.Throws<InvalidDataException>(() =>
                Catalog(uri, false, provider, model).Resolve("p/m")
            );
        Assert.Contains("imageGeneration.model", Fails(ImageSettings(model: null)).Message);
        Assert.Contains("mode separate", Fails(ImageSettings(mode: "hosted")).Message);
        Assert.Contains("imageGeneration.api", Fails(ImageSettings(api: "chat")).Message);
        // A model override that switches to hosted must also leave the Images API.
        Assert.Contains(
            "mode separate",
            Fails(ImageSettings(), new JsonObject { ["mode"] = "hosted" }).Message
        );

        var inherited = Catalog(uri, false, ImageSettings(), JsonValue.Create(true))
            .Resolve("p/m");
        Assert.True(ImageGenerationRequests.UsesImagesApi(
            inherited.Configuration["imageGeneration"] as JsonObject
        ));
        Assert.True(ImageGenerationRequests.UsesSeparateRequest(inherited));
        var legacy = Catalog(uri, false, ImageSettings(mode: "isolated")).Resolve("p/m");
        Assert.True(ImageGenerationRequests.UsesSeparateRequest(legacy));
        var hosted = Catalog(
                uri,
                false,
                ImageSettings(),
                new JsonObject { ["mode"] = "hosted", ["api"] = "responses" }
            )
            .Resolve("p/m");
        Assert.False(ImageGenerationRequests.UsesSeparateRequest(hosted));
        // The model may be supplied by the model override instead of the provider.
        var split = Catalog(
                uri,
                false,
                ImageSettings(model: null),
                new JsonObject { ["model"] = "gpt-image-2.5-flare" }
            )
            .Resolve("p/m");
        Assert.Equal(
            "gpt-image-2.5-flare",
            split.Configuration["imageGeneration"]!["model"]!.GetValue<string>()
        );
    }

    [Theory]
    [InlineData("https://relay.example/v1", false, "https://relay.example/v1/images/generations")]
    [InlineData("https://relay.example/v1/", true, "https://relay.example/v1/images/edits")]
    [InlineData("wss://relay.example/v1", false, "https://relay.example/v1/images/generations")]
    [InlineData("ws://127.0.0.1:8080/api", true, "http://127.0.0.1:8080/api/images/edits")]
    public void Endpoint_uses_http_for_websocket_base_urls(string baseUrl, bool edit, string expected)
    {
        Assert.Equal(
            expected,
            ImagesApiChatService.Endpoint(new Uri(baseUrl), edit).ToString()
        );
    }
}
