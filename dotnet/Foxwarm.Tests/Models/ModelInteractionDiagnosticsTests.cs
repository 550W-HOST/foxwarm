using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class ModelInteractionDiagnosticsTests
{
    private const string OldToken = "synthetic-provider-key-old";
    private const string HeaderSecret = "synthetic-header-credential-old";
    private const string ImageBytes = "c3ludGhldGljLWltYWdlLWJ5dGVz";

    private static JsonObject Catalog(
        Uri uri,
        string type = "openai-responses",
        string token = OldToken
    ) =>
        new()
        {
            ["default"] = "a/m",
            ["providers"] = new JsonObject
            {
                ["a"] = new JsonObject
                {
                    ["providerType"] = type,
                    ["baseUrl"] = uri.ToString(),
                    ["models"] = new JsonArray("m"),
                    ["apiKey"] = token,
                    ["extraHeaders"] = new JsonObject { ["X-Credential"] = HeaderSecret },
                    ["extraFields"] = new JsonObject
                    {
                        ["audit_token"] = token,
                        ["audit_image"] = new JsonObject
                        {
                            ["type"] = "base64",
                            ["media_type"] = "image/png",
                            ["data"] = ImageBytes,
                        },
                        ["business"] = new JsonObject { ["result"] = "ordinary-result" },
                    },
                },
            },
        };

    private static ResponsesClientOptions Options(Uri uri) => new(uri, "m", "a/m", "", "", 713);

    private static JsonObject Answer(string text = "answer") =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["phase"] = "final_answer",
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = text }
            ),
        };

    private static string Sse(JsonObject frame) => "data: " + frame.ToJsonString() + "\n\n";

    private static string Recent(string root) => Path.Combine(root, "state", "logs", "recent");

    [Fact]
    public async Task Ordinary_manager_producer_keeps_wire_payload_headers_and_raw_stream_using_captured_credentials_after_live_config_change()
    {
        using var temp = new TempDirectory();
        ModelConfiguration? configuration = null;
        Uri? target = null;
        await using var peer = new LoopbackResponsesServer(
            async (stream, request) =>
            {
                Assert.Contains(OldToken, request.Body);
                Assert.Equal(HeaderSecret, request.Headers["X-Credential"]);
                await configuration!.SaveAsync(
                    new JsonObject
                    {
                        ["yaml"] = Catalog(target!, token: "synthetic-new-key").ToJsonString(),
                    }
                );
                var response = ResponsesPrefixCommitTests.Completed(
                    Answer("echo " + OldToken + " " + HeaderSecret)
                );
                response["response"]!["wireOnly"] = new JsonObject
                {
                    ["result"] = "business-response",
                };
                var body = Encoding.UTF8.GetBytes(": raw provider prelude\n\n" + Sse(response));
                await stream.WriteAsync(
                    Encoding.ASCII.GetBytes(
                        $"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Diagnostic: {HeaderSecret}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"
                    )
                );
                await stream.WriteAsync(body);
            }
        );
        target = peer.BaseUri;
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        File.WriteAllText(Path.Combine(temp.Path, "state", "config.yaml"), "{}");
        File.WriteAllText(
            Path.Combine(temp.Path, "state", "models.yaml"),
            Catalog(peer.BaseUri).ToJsonString()
        );
        configuration = new ModelConfiguration(temp.Path);
        await using var manager = new SessionManager(
            temp.Path,
            Path.Combine(temp.Path, "work"),
            Options(peer.BaseUri),
            configuration.Models
        );
        await manager.LoadMainHostAsync();
        var hosted = await manager.CreateNamedAsync("main", "diagnostics", null, null);
        hosted.Registry.TriggerOverride = _ => Task.CompletedTask;
        await hosted.Registry.Ingress.EnqueueAsync(
            hosted.Id,
            QueueItem.UserText("actual normal request")
        );
        await hosted.Registry.Runner.ProcessQueueAsync(hosted.Id);
        Assert.Null(hosted.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(1, peer.RequestCount);
        var requestLog = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_req.json"))
            )
        )!;
        Assert.Contains("actual normal request", requestLog.ToJsonString());
        Assert.Equal("ordinary-result", requestLog["business"]!["result"]!.GetValue<string>());
        var responseLog = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))
            )
        )!;
        Assert.Equal("200 OK", responseLog["status"]!.GetValue<string>());
        Assert.NotNull(responseLog["headers"]!["X-Diagnostic"]);
        Assert.Equal(
            "business-response",
            responseLog["body"]!["wireOnly"]!["result"]!.GetValue<string>()
        );
        Assert.Contains(
            "raw provider prelude",
            responseLog["rawStream"]!["body"]!.GetValue<string>()
        );
        Assert.NotEmpty(responseLog["rawStream"]!["sseBlocks"]!.AsArray());
        var persisted = requestLog.ToJsonString() + responseLog.ToJsonString();
        Assert.DoesNotContain(OldToken, persisted);
        Assert.DoesNotContain(HeaderSecret, persisted);
        Assert.DoesNotContain(ImageBytes, persisted);
    }

    [Fact]
    public async Task Malformed_stream_and_compressed_error_diagnostics_survive_the_actual_retry_with_distinct_wire_bodies()
    {
        using var temp = new TempDirectory();
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (number, stream, _) =>
            {
                var body = number switch
                {
                    0 => "data: {provider malformed\n\n",
                    1 => "upstream denied " + OldToken,
                    _ => Sse(ResponsesPrefixCommitTests.Completed(Answer("answer " + OldToken)))
                        .Replace(OldToken, "\\u0073" + OldToken[1..], StringComparison.Ordinal),
                };
                var bytes = Encoding.UTF8.GetBytes(body);
                if (number == 1)
                {
                    using var compressed = new MemoryStream();
                    using (
                        var gzip = new System.IO.Compression.GZipStream(
                            compressed,
                            System.IO.Compression.CompressionLevel.Fastest,
                            true
                        )
                    )
                        gzip.Write(bytes);
                    bytes = compressed.ToArray();
                    await stream.WriteAsync(
                        Encoding.ASCII.GetBytes(
                            $"HTTP/1.1 503 Busy\r\nContent-Encoding: gzip\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n"
                        )
                    );
                    await stream.WriteAsync(bytes);
                }
                else
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        bytes
                    );
            }
        );
        using var http = ProviderHttpRequest.CreateClient();
        var owner = new ModelRequestOwner(
            http,
            Options(peer.BaseUri),
            new ModelRouting(),
            (_, _) => Task.CompletedTask,
            diagnostics: new(temp.Path)
        );
        await Request(owner, HostModels.Parse(Catalog(peer.BaseUri), new JsonObject()));
        var response = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))
            )
        )!;
        var attempts = response["attempts"]!.AsArray();
        Assert.Equal(2, attempts.Count);
        Assert.Contains(
            "provider malformed",
            attempts[0]!["rawStream"]!["body"]!.GetValue<string>()
        );
        Assert.Equal("503 Busy", attempts[1]!["status"]!.GetValue<string>());
        Assert.Contains("upstream denied", attempts[1]!["body"]!.GetValue<string>());
        Assert.DoesNotContain(OldToken, response.ToJsonString());
        Assert.DoesNotContain("u0073" + OldToken[1..], response.ToJsonString());
        Assert.Equal(3, peer.RequestCount);
    }

    [Fact]
    public async Task Raw_capture_is_bounded_without_retaining_a_credential_split_at_its_cutoff()
    {
        using var temp = new TempDirectory();
        const int limit = 5 * 1024 * 1024;
        var secretFragment = OldToken[..^1];
        var prefix = ": " + new string('x', limit - 2 - secretFragment.Length) + OldToken + "\n\n";
        await using var peer = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(
                        prefix + Sse(ResponsesPrefixCommitTests.Completed(Answer()))
                    )
                )
        );
        using var http = ProviderHttpRequest.CreateClient();
        await Request(
            new(http, Options(peer.BaseUri), new ModelRouting(), diagnostics: new(temp.Path)),
            HostModels.Parse(Catalog(peer.BaseUri), new JsonObject())
        );
        var response = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))
            )
        )!;
        var raw = response["rawStream"]!;
        Assert.True(raw["truncated"]!.GetValue<bool>());
        Assert.Equal(limit, raw["maxChars"]!.GetValue<int>());
        Assert.True(raw["body"]!.GetValue<string>().Length <= limit + 20);
        Assert.DoesNotContain(secretFragment, raw.ToJsonString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Diagnostic_write_failures_never_resend_or_hide_a_successful_provider_result(
        bool afterRequest
    )
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.GetDirectoryName(Recent(temp.Path))!);
        if (!afterRequest)
            File.WriteAllText(Recent(temp.Path), "owned blocker");
        await using var peer = new LoopbackResponsesServer(
            async (stream, _) =>
            {
                if (afterRequest)
                {
                    Directory.Delete(Recent(temp.Path), true);
                    File.WriteAllText(Recent(temp.Path), "owned response blocker");
                }
                await LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    200,
                    "text/event-stream",
                    Encoding.UTF8.GetBytes(Sse(ResponsesPrefixCommitTests.Completed(Answer())))
                );
            }
        );
        using var http = ProviderHttpRequest.CreateClient();
        var result = await Request(
            new(http, Options(peer.BaseUri), new ModelRouting(), diagnostics: new(temp.Path)),
            HostModels.Parse(Catalog(peer.BaseUri), new JsonObject())
        );
        Assert.Contains("answer", result.AssistantMessage!.ToJsonString());
        Assert.Equal(1, peer.RequestCount);
    }

    [Fact]
    public async Task Recent_housekeeping_bounds_normal_producers_to_twenty_files_without_touching_dated_or_nested_owners()
    {
        using var temp = new TempDirectory();
        var dated = Path.Combine(temp.Path, "state", "logs", "2000-01-01");
        Directory.CreateDirectory(dated);
        File.WriteAllText(Path.Combine(dated, "archiver-owned"), "untouched");
        Directory.CreateDirectory(Path.Combine(Recent(temp.Path), "nested"));
        File.WriteAllText(Path.Combine(Recent(temp.Path), "nested", "owned"), "untouched");
        using var http = new HttpClient(new SuccessHandler());
        var owner = new ModelRequestOwner(
            http,
            Options(new Uri("http://localhost")),
            new ModelRouting(),
            diagnostics: new(temp.Path)
        );
        var catalog = HostModels.Parse(Catalog(new Uri("http://localhost")), new JsonObject());
        for (var index = 0; index < 12; index++)
            await Request(owner, catalog);
        Assert.Equal(20, Directory.GetFiles(Recent(temp.Path)).Length);
        Assert.True(File.Exists(Path.Combine(dated, "archiver-owned")));
        Assert.True(File.Exists(Path.Combine(Recent(temp.Path), "nested", "owned")));
    }

    [Fact]
    public async Task Hosted_image_streams_keep_only_structural_raw_diagnostics_and_redacted_response_payloads()
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(
            true,
            async (context, _) =>
            {
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.image_generation_call.partial_image",
                        ["partial_image_b64"] = ImageBytes,
                    }
                );
                var response = ResponsesPrefixCommitTests.Completed(Answer("text survives"));
                response["response"]!["opaque"] = new JsonObject
                {
                    ["partial_image_b64"] = ImageBytes,
                };
                await context.Send(response);
            }
        );
        using var http = ProviderHttpRequest.CreateClient();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var catalogJson = Catalog(peer.Uri, "openai-ws");
        catalogJson["providers"]!["a"]!["imageGeneration"] = new JsonObject { ["enabled"] = true };
        await Request(
            new(
                http,
                Options(peer.Uri),
                new ModelRouting(),
                websockets: transport,
                diagnostics: new(temp.Path)
            ),
            HostModels.Parse(catalogJson, new JsonObject())
        );
        var response = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))
            )
        )!;
        Assert.Equal("101 WebSocket", response["status"]!.GetValue<string>());
        Assert.True(response["rawStream"]!["contentOmitted"]!.GetValue<bool>());
        Assert.Null(response["rawStream"]!["body"]);
        Assert.Contains("text survives", response["body"]!.ToJsonString());
        Assert.DoesNotContain(ImageBytes, response.ToJsonString());
    }

    [Fact]
    public async Task Ordinary_websocket_frames_remain_raw_diagnostics_not_just_semantic_results()
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(
            true,
            async (context, _) =>
            {
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.vendor_probe",
                        ["opaque"] = "wire-only-frame",
                    }
                );
                await context.Send(ResponsesPrefixCommitTests.Completed(Answer()));
            }
        );
        using var http = ProviderHttpRequest.CreateClient();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        await Request(
            new(
                http,
                Options(peer.Uri),
                new ModelRouting(),
                websockets: transport,
                diagnostics: new(temp.Path)
            ),
            HostModels.Parse(Catalog(peer.Uri, "openai-ws"), new JsonObject())
        );
        var response = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))
            )
        )!;
        Assert.Contains("wire-only-frame", response["rawStream"]!["body"]!.GetValue<string>());
        Assert.Equal(2, response["rawStream"]!["sseBlocks"]!.AsArray().Count);
        Assert.DoesNotContain("wire-only-frame", response["body"]!.ToJsonString());
    }

    [Fact]
    public async Task Terminal_provider_error_moves_its_redacted_wire_evidence_into_the_existing_date_error_directory()
    {
        using var temp = new TempDirectory();
        await using var peer = new LoopbackResponsesServer(
            (stream, _) =>
                LoopbackResponsesServer.WriteResponseAsync(
                    stream,
                    400,
                    "application/json",
                    Encoding.UTF8.GetBytes("terminal evidence " + OldToken)
                )
        );
        using var http = ProviderHttpRequest.CreateClient();
        await Assert.ThrowsAsync<ModelRequestException>(() =>
            Request(
                new(http, Options(peer.BaseUri), new ModelRouting(), diagnostics: new(temp.Path)),
                HostModels.Parse(Catalog(peer.BaseUri), new JsonObject())
            )
        );
        Assert.Empty(Directory.GetFiles(Recent(temp.Path)));
        var directory = Assert.Single(
            Directory.GetDirectories(Path.Combine(temp.Path, "state", "logs"), "*-error")
        );
        Assert.Equal(2, Directory.GetFiles(directory).Length);
        var response = await File.ReadAllTextAsync(
            Assert.Single(Directory.GetFiles(directory, "*_res.json"))
        );
        Assert.Contains("terminal evidence", response);
        Assert.DoesNotContain(OldToken, response);
        Assert.Equal(1, peer.RequestCount);
    }

    [Theory]
    [InlineData("openai-responses", true)]
    [InlineData("anthropic", true)]
    [InlineData("openai-responses", false)]
    [InlineData("anthropic", false)]
    public async Task HTTP_error_diagnostics_redact_complete_and_collector_cut_credentials(
        string protocol,
        bool truncated
    )
    {
        using var temp = new TempDirectory();
        var fragment = OldToken[..^1];
        var evidence = "terminal evidence " + new string('x', 80);
        var body = truncated
            ? evidence
                + new string('x', 65536 - evidence.Length - fragment.Length)
                + OldToken
                + " trailing evidence"
            : evidence + " " + OldToken + " ordinary partial label " + fragment;
        using var handler = new DiagnosticHandler((_, _) => (HttpStatusCode.BadRequest, body));
        using var http = new HttpClient(handler);
        var uri = new Uri("http://unused.invalid");
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            Request(
                new(http, Options(uri), new ModelRouting(), diagnostics: new(temp.Path)),
                HostModels.Parse(Catalog(uri, protocol), new JsonObject())
            )
        );
        Assert.Single(handler.Bodies);
        Assert.True(error.Final.Final);
        Assert.Equal(1, error.Final.Attempt);
        Assert.Equal("http-error", error.Final.Kind);
        Assert.Equal("400", error.Final.Status);
        Assert.Null(error.Final.NextAttempt);
        var persisted = await File.ReadAllTextAsync(
            Assert.Single(
                Directory.GetFiles(
                    Path.Combine(temp.Path, "state", "logs"),
                    "*_res.json",
                    SearchOption.AllDirectories
                )
            )
        );
        var attempt = Assert.Single(JsonNode.Parse(persisted)!["attempts"]!.AsArray())!;
        Assert.Contains(evidence, attempt["body"]!.GetValue<string>());
        if (protocol == "anthropic")
            Assert.Contains(evidence, attempt["error"]!.GetValue<string>());
        Assert.DoesNotContain(OldToken, persisted);
        if (truncated)
            Assert.DoesNotContain(fragment, persisted);
        else
        {
            Assert.Contains(
                "ordinary partial label " + fragment,
                attempt["body"]!.GetValue<string>()
            );
            if (protocol == "anthropic")
                Assert.Contains(
                    "ordinary partial label " + fragment,
                    attempt["error"]!.GetValue<string>()
                );
        }
    }

    [Theory]
    [InlineData("\n\n", false)]
    [InlineData("", false)]
    [InlineData("\\u00", false)]
    [InlineData("\\u00", true)]
    public async Task Malformed_escaped_credentials_are_redacted_at_a_block_or_interruption_boundary(
        string ending,
        bool partial
    )
    {
        using var temp = new TempDirectory();
        var encoded = "\\u0073" + (partial ? OldToken[1..^1] : OldToken[1..]);
        var raw =
            "data: {\"type\":\"response.vendor\",\"business\":{\"result\":\"keep-evidence\"},\"message\":\""
            + encoded
            + ending;
        using var handler = new DiagnosticHandler((_, _) => (HttpStatusCode.OK, raw));
        using var http = new HttpClient(handler);
        var uri = new Uri("http://unused.invalid");
        await Assert.ThrowsAsync<ModelRequestException>(() =>
            Request(
                new(
                    http,
                    Options(uri),
                    new ModelRouting(),
                    (_, _) => Task.CompletedTask,
                    diagnostics: new(temp.Path)
                ),
                HostModels.Parse(Catalog(uri), new JsonObject())
            )
        );
        Assert.Equal(6, handler.Bodies.Count);
        var log = await ReadResponse(temp.Path);
        foreach (var attempt in log["attempts"]!.AsArray())
        {
            var captured = attempt!["rawStream"]!["body"]!.GetValue<string>();
            Assert.Contains("keep-evidence", captured);
            Assert.DoesNotContain(encoded, captured);
            Assert.DoesNotContain(OldToken, captured);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Observed_image_output_omits_raw_escaped_fields_and_unterminated_first_events(
        bool interrupted
    )
    {
        using var temp = new TempDirectory();
        var raw = interrupted
            ? "data: {\"type\":\"response.image_generation_call.partial_image\",\"partial_image_b64\":\""
                + ImageBytes
                + "\"}"
            : Sse(ResponsesPrefixCommitTests.Completed(Answer()))
                .Replace(
                    "\"usage\":",
                    "\"opaque\":{\"partial\\u005fimage_b64\":\"" + ImageBytes + "\"},\"usage\":",
                    StringComparison.Ordinal
                );
        using var handler = new DiagnosticHandler((_, _) => (HttpStatusCode.OK, raw));
        using var http = new HttpClient(handler);
        var uri = new Uri("http://unused.invalid");
        var call = Request(
            new(
                http,
                Options(uri),
                new ModelRouting(),
                (_, _) => Task.CompletedTask,
                diagnostics: new(temp.Path)
            ),
            HostModels.Parse(Catalog(uri), new JsonObject())
        );
        if (interrupted)
            await Assert.ThrowsAsync<ModelRequestException>(() => call);
        else
            Assert.Contains("answer", (await call).AssistantMessage!.ToJsonString());
        var log = await ReadResponse(temp.Path);
        var captures = log["attempts"] as JsonArray ?? new JsonArray(log.DeepClone());
        foreach (var captured in captures)
        {
            Assert.True(captured!["rawStream"]!["contentOmitted"]?.GetValue<bool>() == true);
            Assert.Null(captured["rawStream"]!["body"]);
        }
        Assert.DoesNotContain(ImageBytes, log.ToJsonString());
    }

    [Fact]
    public async Task Native_image_replay_with_tool_disabled_keeps_structural_only_raw_capture()
    {
        using var temp = new TempDirectory();
        const string png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        var images = new Foxwarm.Images.ImageBlobStore(temp.Path);
        var normalized = await HostedResponsesTools.ExternalizeAsync(
            new JsonArray(
                new JsonObject
                {
                    ["type"] = "image_generation_call",
                    ["id"] = "replayed",
                    ["status"] = "completed",
                    ["output_format"] = "png",
                    ["result"] = png,
                }
            ),
            images,
            "a/m",
            default
        );
        var history = new[]
        {
            new JsonObject { ["role"] = "model", ["parts"] = new JsonArray(normalized.Parts[0]) },
        };
        using var handler = new DiagnosticHandler(
            (_, body) =>
            {
                var wire = JsonNode.Parse(body)!;
                Assert.Contains(
                    wire["input"]!.AsArray(),
                    item => item?["type"]?.GetValue<string>() == "image_generation_call"
                );
                Assert.DoesNotContain(
                    wire["tools"]?.AsArray() ?? [],
                    item => item?["type"]?.GetValue<string>() == "image_generation"
                );
                return (
                    HttpStatusCode.OK,
                    ": unrelated provider evidence\n\n"
                        + Sse(ResponsesPrefixCommitTests.Completed(Answer()))
                );
            }
        );
        using var http = new HttpClient(handler);
        var uri = new Uri("http://unused.invalid");
        var owner = new ModelRequestOwner(
            http,
            Options(uri),
            new ModelRouting(),
            images: images,
            diagnostics: new(temp.Path)
        );
        await owner.RequestAsync(
            "s",
            HostModels.Parse(Catalog(uri), new JsonObject()),
            "a/m",
            null,
            "cache",
            "turn",
            history,
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            default
        );
        var log = await ReadResponse(temp.Path);
        Assert.True(log["rawStream"]!["contentOmitted"]?.GetValue<bool>() == true);
        Assert.Null(log["rawStream"]!["body"]);
        Assert.DoesNotContain(
            png,
            await File.ReadAllTextAsync(
                Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_req.json"))
            )
        );
    }

    [Theory]
    [InlineData("history")]
    [InlineData("context")]
    [InlineData("unchanged")]
    public async Task Canonical_retry_raw_pairs_follow_the_existing_logical_context_identity(
        string change
    )
    {
        using var temp = new TempDirectory();
        using var handler = new DiagnosticHandler(
            (number, _) =>
                number == 1
                    ? (HttpStatusCode.ServiceUnavailable, "retry evidence")
                    : (HttpStatusCode.OK, Sse(ResponsesPrefixCommitTests.Completed(Answer())))
        );
        using var http = new HttpClient(handler);
        var uri = new Uri("http://unused.invalid");
        var owner = new ModelRequestOwner(
            http,
            Options(uri),
            new ModelRouting(),
            (_, _) => Task.CompletedTask,
            diagnostics: new(temp.Path)
        );
        static JsonObject User(string text) =>
            new()
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            };
        var context = false;
        await owner.RequestAsync(
            "s",
            HostModels.Parse(Catalog(uri), new JsonObject()),
            "a/m",
            null,
            "cache",
            "turn",
            [User("original")],
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            default,
            ModelRequestScope.Canonical,
            prepareRetry: _ =>
            {
                context = true;
                return Task.FromResult<IReadOnlyList<JsonObject>?>(
                    change == "history" ? [User("original"), User("new-input")] : null
                );
            },
            requestContext: () =>
                Task.FromResult<IReadOnlyList<JsonObject>>(
                    change == "context" && context ? [User("new-input")] : []
                )
        );
        Assert.Equal(2, handler.Bodies.Count);
        var paths = Directory.GetFiles(Recent(temp.Path), "*_req.json");
        Assert.Equal(change == "unchanged" ? 1 : 2, paths.Length);
        if (change != "unchanged")
        {
            Assert.Contains("new-input", handler.Bodies[1]);
            var current = Assert.Single(
                paths,
                path => File.ReadAllText(path).Contains("new-input", StringComparison.Ordinal)
            );
            var response = JsonNode.Parse(
                await File.ReadAllTextAsync(
                    current.Replace("_req.json", "_res.json", StringComparison.Ordinal)
                )
            )!;
            Assert.Contains("answer", response["body"]!.ToJsonString());
            Assert.Null(response["attempts"]);
            var previous = Assert.Single(paths, path => path != current);
            Assert.Contains(
                "retry evidence",
                await File.ReadAllTextAsync(
                    previous.Replace("_req.json", "_res.json", StringComparison.Ordinal)
                )
            );
        }
        else
        {
            var response = await ReadResponse(temp.Path);
            Assert.Single(response["attempts"]!.AsArray());
            Assert.Equal(
                JsonNode.Parse(handler.Bodies[0])!.ToJsonString(),
                JsonNode.Parse(handler.Bodies[1])!.ToJsonString()
            );
        }
    }

    [Fact]
    public async Task Unchanged_virtual_failover_updates_the_current_raw_request_and_keeps_its_selections()
    {
        using var temp = new TempDirectory();
        using var handler = new DiagnosticHandler(
            (number, _) =>
                number == 1
                    ? (HttpStatusCode.ServiceUnavailable, "first leaf failed")
                    : (HttpStatusCode.OK, Sse(ResponsesPrefixCommitTests.Completed(Answer())))
        );
        using var http = new HttpClient(handler);
        var uri = new Uri("http://unused.invalid");
        var config = Catalog(uri);
        config["providers"]!["b"] = config["providers"]!["a"]!.DeepClone();
        config["providers"]!["route"] = new JsonObject
        {
            ["providerType"] = "failover",
            ["targets"] = new JsonArray("a/m", "b/m"),
            ["failureThreshold"] = 1,
        };
        var owner = new ModelRequestOwner(
            http,
            Options(uri),
            new ModelRouting(),
            (_, _) => Task.CompletedTask,
            diagnostics: new(temp.Path)
        );
        await owner.RequestAsync(
            "s",
            HostModels.Parse(config, new JsonObject()),
            "route",
            null,
            "cache",
            "turn",
            [],
            (leaf, _) => Task.FromResult("prompt " + leaf.Key),
            null,
            null,
            null,
            null,
            default
        );
        var path = Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_req.json"));
        var raw = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
        Assert.Equal("route", raw["virtualModelKey"]!.GetValue<string>());
        Assert.Equal("b/m", raw["selectedModelId"]!.GetValue<string>());
        Assert.Equal(
            new[] { "a/m", "b/m" },
            raw["selections"]!.AsArray().Select(item => item!["modelId"]!.GetValue<string>())
        );
        Assert.Contains("prompt b/m", raw["request"]!.ToJsonString());
        var response = await ReadResponse(temp.Path);
        Assert.Single(response["attempts"]!.AsArray());
        Assert.Contains("answer", response["body"]!.ToJsonString());
    }

    [Fact]
    public async Task Effective_image_configuration_omits_raw_content_even_when_purpose_filters_the_tool()
    {
        using var temp = new TempDirectory();
        using var handler = new DiagnosticHandler(
            (_, body) =>
            {
                Assert.DoesNotContain("image_generation", body);
                return (HttpStatusCode.OK, Sse(ResponsesPrefixCommitTests.Completed(Answer())));
            }
        );
        using var http = new HttpClient(handler);
        var uri = new Uri("http://unused.invalid");
        var config = Catalog(uri);
        config["providers"]!["a"]!["imageGeneration"] = new JsonObject { ["enabled"] = true };
        var owner = new ModelRequestOwner(
            http,
            Options(uri),
            new ModelRouting(),
            diagnostics: new(temp.Path)
        );
        await owner.RequestAsync(
            "s",
            HostModels.Parse(config, new JsonObject()),
            "a/m",
            null,
            "cache",
            "turn",
            [],
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            default,
            journalPurpose: "compact-plan"
        );
        var raw = (await ReadResponse(temp.Path))["rawStream"]!;
        Assert.True(raw["contentOmitted"]?.GetValue<bool>() == true);
        Assert.Null(raw["body"]);
    }

    private static async Task<JsonObject> ReadResponse(string root) =>
        JsonNode
            .Parse(
                await File.ReadAllTextAsync(
                    Assert.Single(
                        Directory.GetFiles(
                            Path.Combine(root, "state", "logs"),
                            "*_res.json",
                            SearchOption.AllDirectories
                        )
                    )
                )
            )!
            .AsObject();

    private sealed class DiagnosticHandler(
        Func<int, string, (HttpStatusCode Status, string Body)> reply
    ) : HttpMessageHandler
    {
        internal readonly List<string> Bodies = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        )
        {
            var body = await request.Content!.ReadAsStringAsync(token);
            Bodies.Add(body);
            var result = reply(Bodies.Count, body);
            return new HttpResponseMessage(result.Status)
            {
                Content = new StringContent(result.Body, Encoding.UTF8, "text/event-stream"),
            };
        }
    }

    private static Task<ChatResult> Request(ModelRequestOwner owner, HostModels catalog) =>
        owner.RequestAsync(
            "s",
            catalog,
            "a/m",
            null,
            "cache",
            "turn",
            [],
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            default
        );

    private sealed class SuccessHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken token
        ) =>
            Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        Sse(ResponsesPrefixCommitTests.Completed(Answer()))
                    ),
                }
            );
    }
}
