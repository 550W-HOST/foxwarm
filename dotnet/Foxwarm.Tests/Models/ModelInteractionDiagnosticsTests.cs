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
    private static JsonObject Catalog(Uri uri, string type = "openai-responses", string token = OldToken) => new()
    {
        ["default"] = "a/m", ["providers"] = new JsonObject { ["a"] = new JsonObject
        {
            ["providerType"] = type, ["baseUrl"] = uri.ToString(), ["models"] = new JsonArray("m"), ["apiKey"] = token,
            ["extraHeaders"] = new JsonObject { ["X-Credential"] = HeaderSecret },
            ["extraFields"] = new JsonObject
            {
                ["audit_token"] = token,
                ["audit_image"] = new JsonObject { ["type"] = "base64", ["media_type"] = "image/png", ["data"] = ImageBytes },
                ["business"] = new JsonObject { ["result"] = "ordinary-result" },
            },
        } },
    };
    private static ResponsesClientOptions Options(Uri uri) => new(uri, "m", "a/m", "", "", 713);
    private static JsonObject Answer(string text = "answer") => new()
    {
        ["type"] = "message", ["role"] = "assistant", ["phase"] = "final_answer",
        ["content"] = new JsonArray(new JsonObject { ["type"] = "output_text", ["text"] = text }),
    };
    private static string Sse(JsonObject frame) => "data: " + frame.ToJsonString() + "\n\n";
    private static string Recent(string root) => Path.Combine(root, "state", "logs", "recent");

    [Fact]
    public async Task Ordinary_manager_producer_keeps_wire_payload_headers_and_raw_stream_using_captured_credentials_after_live_config_change()
    {
        using var temp = new TempDirectory();
        ModelConfiguration? configuration = null;
        Uri? target = null;
        await using var peer = new LoopbackResponsesServer(async (stream, request) =>
        {
            Assert.Contains(OldToken, request.Body);
            Assert.Equal(HeaderSecret, request.Headers["X-Credential"]);
            await configuration!.SaveAsync(new JsonObject { ["yaml"] = Catalog(target!, token: "synthetic-new-key").ToJsonString() });
            var response = ResponsesPrefixCommitTests.Completed(Answer("echo " + OldToken + " " + HeaderSecret));
            response["response"]!["wireOnly"] = new JsonObject { ["result"] = "business-response" };
            var body = Encoding.UTF8.GetBytes(": raw provider prelude\n\n" + Sse(response));
            await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nX-Diagnostic: {HeaderSecret}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n"));
            await stream.WriteAsync(body);
        });
        target = peer.BaseUri;
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        File.WriteAllText(Path.Combine(temp.Path, "state", "config.yaml"), "{}");
        File.WriteAllText(Path.Combine(temp.Path, "state", "models.yaml"), Catalog(peer.BaseUri).ToJsonString());
        configuration = new ModelConfiguration(temp.Path);
        await using var manager = new SessionManager(temp.Path, Path.Combine(temp.Path, "work"), Options(peer.BaseUri), configuration.Models);
        await manager.LoadMainHostAsync();
        var hosted = await manager.CreateNamedAsync("main", "diagnostics", null, null);
        hosted.Registry.TriggerOverride = _ => Task.CompletedTask;
        await hosted.Registry.Ingress.EnqueueAsync(hosted.Id, QueueItem.UserText("actual normal request"));
        await hosted.Registry.Runner.ProcessQueueAsync(hosted.Id);
        Assert.Null(hosted.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(1, peer.RequestCount);
        var requestLog = JsonNode.Parse(await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_req.json"))))!;
        Assert.Contains("actual normal request", requestLog.ToJsonString());
        Assert.Equal("ordinary-result", requestLog["business"]!["result"]!.GetValue<string>());
        var responseLog = JsonNode.Parse(await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))))!;
        Assert.Equal("200 OK", responseLog["status"]!.GetValue<string>());
        Assert.NotNull(responseLog["headers"]!["X-Diagnostic"]);
        Assert.Equal("business-response", responseLog["body"]!["wireOnly"]!["result"]!.GetValue<string>());
        Assert.Contains("raw provider prelude", responseLog["rawStream"]!["body"]!.GetValue<string>());
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
        await using var peer = new ScriptedResponsesSequenceServer(3, async (number, stream, _) =>
        {
            var body = number switch { 0 => "data: {provider malformed\n\n", 1 => "upstream denied " + OldToken, _ => Sse(ResponsesPrefixCommitTests.Completed(Answer("answer " + OldToken))).Replace(OldToken, "\\u0073" + OldToken[1..], StringComparison.Ordinal) };
            var bytes = Encoding.UTF8.GetBytes(body);
            if (number == 1)
            {
                using var compressed = new MemoryStream();
                using (var gzip = new System.IO.Compression.GZipStream(compressed, System.IO.Compression.CompressionLevel.Fastest, true)) gzip.Write(bytes);
                bytes = compressed.ToArray();
                await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 503 Busy\r\nContent-Encoding: gzip\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n"));
                await stream.WriteAsync(bytes);
            }
            else await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", bytes);
        });
        using var http = ProviderHttpRequest.CreateClient();
        var owner = new ModelRequestOwner(http, Options(peer.BaseUri), new ModelRouting(), (_, _) => Task.CompletedTask, diagnostics: new(temp.Path));
        await Request(owner, HostModels.Parse(Catalog(peer.BaseUri), new JsonObject()));
        var response = JsonNode.Parse(await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))))!;
        var attempts = response["attempts"]!.AsArray();
        Assert.Equal(2, attempts.Count);
        Assert.Contains("provider malformed", attempts[0]!["rawStream"]!["body"]!.GetValue<string>());
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
        await using var peer = new LoopbackResponsesServer((stream, _) => LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Encoding.UTF8.GetBytes(prefix + Sse(ResponsesPrefixCommitTests.Completed(Answer())))));
        using var http = ProviderHttpRequest.CreateClient();
        await Request(new(http, Options(peer.BaseUri), new ModelRouting(), diagnostics: new(temp.Path)), HostModels.Parse(Catalog(peer.BaseUri), new JsonObject()));
        var response = JsonNode.Parse(await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))))!;
        var raw = response["rawStream"]!;
        Assert.True(raw["truncated"]!.GetValue<bool>());
        Assert.Equal(limit, raw["maxChars"]!.GetValue<int>());
        Assert.True(raw["body"]!.GetValue<string>().Length <= limit + 20);
        Assert.DoesNotContain(secretFragment, raw.ToJsonString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Diagnostic_write_failures_never_resend_or_hide_a_successful_provider_result(bool afterRequest)
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.GetDirectoryName(Recent(temp.Path))!);
        if (!afterRequest) File.WriteAllText(Recent(temp.Path), "owned blocker");
        await using var peer = new LoopbackResponsesServer(async (stream, _) =>
        {
            if (afterRequest)
            {
                Directory.Delete(Recent(temp.Path), true);
                File.WriteAllText(Recent(temp.Path), "owned response blocker");
            }
            await LoopbackResponsesServer.WriteResponseAsync(stream, 200, "text/event-stream", Encoding.UTF8.GetBytes(Sse(ResponsesPrefixCommitTests.Completed(Answer()))));
        });
        using var http = ProviderHttpRequest.CreateClient();
        var result = await Request(new(http, Options(peer.BaseUri), new ModelRouting(), diagnostics: new(temp.Path)), HostModels.Parse(Catalog(peer.BaseUri), new JsonObject()));
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
        var owner = new ModelRequestOwner(http, Options(new Uri("http://localhost")), new ModelRouting(), diagnostics: new(temp.Path));
        var catalog = HostModels.Parse(Catalog(new Uri("http://localhost")), new JsonObject());
        for (var index = 0; index < 12; index++) await Request(owner, catalog);
        Assert.Equal(20, Directory.GetFiles(Recent(temp.Path)).Length);
        Assert.True(File.Exists(Path.Combine(dated, "archiver-owned")));
        Assert.True(File.Exists(Path.Combine(Recent(temp.Path), "nested", "owned")));
    }

    [Fact]
    public async Task Hosted_image_streams_keep_only_structural_raw_diagnostics_and_redacted_response_payloads()
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(true, async (context, _) =>
        {
            await context.Send(new JsonObject { ["type"] = "response.image_generation_call.partial_image", ["partial_image_b64"] = ImageBytes });
            var response = ResponsesPrefixCommitTests.Completed(Answer("text survives"));
            response["response"]!["opaque"] = new JsonObject { ["partial_image_b64"] = ImageBytes };
            await context.Send(response);
        });
        using var http = ProviderHttpRequest.CreateClient();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        var catalogJson = Catalog(peer.Uri, "openai-ws");
        catalogJson["providers"]!["a"]!["imageGeneration"] = new JsonObject { ["enabled"] = true };
        await Request(new(http, Options(peer.Uri), new ModelRouting(), websockets: transport, diagnostics: new(temp.Path)), HostModels.Parse(catalogJson, new JsonObject()));
        var response = JsonNode.Parse(await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))))!;
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
        await using var peer = await StreamingModelPeer.StartAsync(true, async (context, _) =>
        {
            await context.Send(new JsonObject { ["type"] = "response.vendor_probe", ["opaque"] = "wire-only-frame" });
            await context.Send(ResponsesPrefixCommitTests.Completed(Answer()));
        });
        using var http = ProviderHttpRequest.CreateClient();
        await using var transport = new ResponsesWsTransport(diagnostics: _ => { });
        await Request(new(http, Options(peer.Uri), new ModelRouting(), websockets: transport, diagnostics: new(temp.Path)), HostModels.Parse(Catalog(peer.Uri, "openai-ws"), new JsonObject()));
        var response = JsonNode.Parse(await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Recent(temp.Path), "*_res.json"))))!;
        Assert.Contains("wire-only-frame", response["rawStream"]!["body"]!.GetValue<string>());
        Assert.Equal(2, response["rawStream"]!["sseBlocks"]!.AsArray().Count);
        Assert.DoesNotContain("wire-only-frame", response["body"]!.ToJsonString());
    }

    [Fact]
    public async Task Terminal_provider_error_moves_its_redacted_wire_evidence_into_the_existing_date_error_directory()
    {
        using var temp = new TempDirectory();
        await using var peer = new LoopbackResponsesServer((stream, _) => LoopbackResponsesServer.WriteResponseAsync(stream, 400, "application/json", Encoding.UTF8.GetBytes("terminal evidence " + OldToken)));
        using var http = ProviderHttpRequest.CreateClient();
        await Assert.ThrowsAsync<ModelRequestException>(() => Request(new(http, Options(peer.BaseUri), new ModelRouting(), diagnostics: new(temp.Path)), HostModels.Parse(Catalog(peer.BaseUri), new JsonObject())));
        Assert.Empty(Directory.GetFiles(Recent(temp.Path)));
        var directory = Assert.Single(Directory.GetDirectories(Path.Combine(temp.Path, "state", "logs"), "*-error"));
        Assert.Equal(2, Directory.GetFiles(directory).Length);
        var response = await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(directory, "*_res.json")));
        Assert.Contains("terminal evidence", response);
        Assert.DoesNotContain(OldToken, response);
        Assert.Equal(1, peer.RequestCount);
    }

    private static Task<ChatResult> Request(ModelRequestOwner owner, HostModels catalog) => owner.RequestAsync("s", catalog, "a/m", null, "cache", "turn", [], (_, _) => Task.FromResult("prompt"), null, null, null, null, default);
    private sealed class SuccessHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(Sse(ResponsesPrefixCommitTests.Completed(Answer()))),
        });
    }
}
