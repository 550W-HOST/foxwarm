using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed partial class TextRedactionTests
{
    internal static JsonObject Settings(Uri endpoint) =>
        new() { ["enabled"] = true, ["endpoint"] = endpoint.ToString() };

    [Fact]
    public async Task Config_inherits_fields_disables_leaves_and_survives_structured_saves()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        const string yaml = """
            defaults:
              textRedaction: {enabled: true, endpoint: 'http://127.0.0.1:1/classify', threshold: 0.4, timeoutMs: 1234}
            providers:
              p:
                baseUrl: http://127.0.0.1:2
                textRedaction: {threshold: 0.7}
                models: [inherited, {id: disabled, textRedaction: false}, {id: tuned, textRedaction: {timeoutMs: 9000}}]
              off: {baseUrl: 'http://127.0.0.1:2', textRedaction: false}
            """;
        await configuration.SaveAsync(new JsonObject { ["yaml"] = yaml });
        var catalog = configuration.Capture();
        var inherited = TextRedactionOptions.FromResolved(
            catalog.Resolve("p/inherited").Configuration["textRedaction"]!.AsObject()
        )!;
        Assert.Equal(0.7, inherited.Threshold);
        Assert.Equal(1234, inherited.TimeoutMs);
        Assert.Null(
            TextRedactionOptions.FromResolved(
                catalog.Resolve("p/disabled").Configuration["textRedaction"]!.AsObject()
            )
        );
        Assert.Null(
            TextRedactionOptions.FromResolved(
                catalog.Resolve("off").Configuration["textRedaction"]!.AsObject()
            )
        );
        Assert.Equal(
            9000,
            TextRedactionOptions
                .FromResolved(
                    catalog.Resolve("p/tuned").Configuration["textRedaction"]!.AsObject()
                )!
                .TimeoutMs
        );
        await configuration.SaveAsync(
            JsonNode
                .Parse(
                    """
                    {"providers":[{"id":"p","models":"inherited,disabled,tuned"},{"id":"off","models":"m"}]}
                    """
                )!
                .AsObject()
        );
        Assert.Equal(
            9000,
            TextRedactionOptions
                .FromResolved(
                    configuration.Capture().Resolve("p/tuned").Configuration[
                        "textRedaction"
                    ]!.AsObject()
                )!
                .TimeoutMs
        );
        var installed = await File.ReadAllTextAsync(configuration.ActivePath);
        Assert.Contains("textRedaction", installed);
        Assert.Null(
            TextRedactionOptions.FromResolved(
                HostModels
                    .Parse(
                        JsonNode
                            .Parse(
                                """
                                {"providers":{"p":{}}}
                                """
                            )!
                            .AsObject(),
                        new()
                    )
                    .Resolve("p")
                    .Configuration["textRedaction"]!.AsObject()
            )
        );
        foreach (
            var invalid in new[]
            {
                "null",
                "{\"threshold\":true}",
                "{\"threshold\":1.1}",
                "{\"timeoutMs\":0}",
                "{\"endpoint\":\"file:///tmp/a\"}",
                "{\"unused\":true}",
                "true",
            }
        )
        {
            var root = JsonNode
                .Parse("{\"providers\":{\"p\":{\"textRedaction\":" + invalid + "}}}")!
                .AsObject();
            Assert.Throws<InvalidDataException>(() => HostModels.Parse(root, new()));
        }
    }

    [Fact]
    public async Task Unicode_offsets_stable_keys_reverse_lookup_and_bounded_history_cache()
    {
        const string secret = "张三😀";
        await using var detector = await TextDetectionPeer.StartAsync(secret);
        using var http = ProviderHttpRequest.CreateClient();
        var settings = new TextRedactionOptions(
            detector.Endpoint,
            "detector-credential",
            0.5,
            30000
        );
        var redactor = new TextRedactor(cacheCharacters: 200000);
        var text = "前🙂 " + secret + " " + new string('a', 60000);
        var first = await redactor.RedactAsync(http, settings, text, default);
        for (var i = 0; i < 8; i++)
            Assert.Equal(first, await redactor.RedactAsync(http, settings, text, default));
        Assert.Single(detector.Texts);
        Assert.Equal("Bearer detector-credential", detector.Authorization);
        var key = await redactor.RedactAsync(http, settings, secret, default);
        Assert.Contains(key, first);
        var another = new TextRedactor();
        Assert.Equal(key, await another.RedactAsync(http, settings, secret, default));
        Assert.Equal(text, redactor.Restore(first));
        Assert.Equal(
            "[[FW_PRIVATE_" + new string('0', 64) + "]]",
            redactor.Restore("[[FW_PRIVATE_" + new string('0', 64) + "]]")
        );
        for (var i = 1; i < key.Length; i++)
            Assert.Equal("prefix ", redactor.RestoreProgress("prefix " + key[..i]));
        Assert.Equal("prefix " + secret, redactor.RestoreProgress("prefix " + key));
        var tiny = new TextRedactor(cacheCharacters: 10);
        await tiny.RedactAsync(http, settings, text, default);
        await tiny.RedactAsync(http, settings, text, default);
        Assert.Equal(3, detector.Texts.Count(value => value == text));
    }

    [Fact]
    public async Task Malformed_offsets_fail_closed_and_unknown_categories_are_redacted()
    {
        await using var detector = await TextDetectionPeer.StartAsync("😀");
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, .5, 30000);
        detector.Transform = value =>
        {
            value["entities"]![0]!["start"] = 1;
            return value;
        };
        var failure = await Assert.ThrowsAsync<TextRedactionException>(() =>
            new TextRedactor().RedactAsync(http, options, "😀", default)
        );
        Assert.False(failure.Retryable);
        detector.Transform = value =>
        {
            value["entities"]![0]!["label"] = "future_category";
            return value;
        };
        var redactor = new TextRedactor();
        var result = await redactor.RedactAsync(http, options, "😀", default);
        Assert.DoesNotContain("😀", result);
        Assert.Equal("😀", redactor.Restore(result));
    }

    [Theory]
    [InlineData(503, 6)]
    [InlineData(429, 6)]
    [InlineData(401, 1)]
    [InlineData(413, 1)]
    [InlineData(400, 1)]
    public async Task Detection_failures_share_budget_without_sending_or_changing_provider_health(
        int status,
        int attempts
    )
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, _) =>
        {
            context.Response.StatusCode = status;
            await context.Response.WriteAsync("failure");
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        var catalog = Catalog(detector.Endpoint, new Uri("http://127.0.0.1:1"));
        var routing = new ModelRouting();
        using var temp = new TempDirectory();
        using var journal = new LlmRequestJournalStore(temp.Path);
        string? requestId = null;
        var owner = new ModelRequestOwner(
            http,
            new(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100),
            routing,
            (_, _) => Task.CompletedTask,
            journal: journal
        );
        var notices = new List<ModelRetryEvent>();
        var sent = 0;
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            owner.RequestAsync(
                "s",
                catalog,
                "route",
                null,
                "cache",
                "turn",
                [ChatResult.Text("secret").AssistantMessage!],
                (_, _) => Task.FromResult(""),
                value =>
                {
                    notices.Add(value);
                    return Task.FromResult(false);
                },
                () => sent++,
                null,
                null,
                default,
                journalRequestStarted: id => requestId = id
            )
        );
        Assert.Equal(attempts, error.Final.Attempt);
        Assert.Equal(attempts, detector.Texts.Count);
        Assert.Equal(0, sent);
        Assert.Empty((await journal.ReconstructAsync(requestId!))["attempts"]!.AsArray());
        Assert.All(
            notices,
            value =>
            {
                Assert.Equal("text-redaction", value.Kind);
                Assert.Equal("p/m", value.ModelId);
            }
        );
        Assert.Equal("p/m", error.Final.ModelId);
        Assert.Empty(routing.Begin("route", catalog.Resolve("route")).Health);
    }

    [Fact]
    public async Task Stop_during_detection_has_one_attempt_and_no_provider_send()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        detector.Intercept = async (context, _) =>
        {
            entered.TrySetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, context.RequestAborted);
            }
            catch (OperationCanceledException) { }
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        using var stop = new CancellationTokenSource();
        var catalog = Catalog(detector.Endpoint, new("http://127.0.0.1:1"));
        var owner = new ModelRequestOwner(
            http,
            new(new("http://127.0.0.1:1"), "m", "p/m", "", "", 100),
            new(),
            (_, _) => throw new Exception("Unexpected retry")
        );
        var request = owner.RequestAsync(
            "s",
            catalog,
            "p/m",
            null,
            "cache",
            "turn",
            [ChatResult.Text("input").AssistantMessage!],
            (_, _) => Task.FromResult(""),
            null,
            () => throw new Exception("Unexpected provider send"),
            null,
            null,
            stop.Token
        );
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        stop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        Assert.Single(detector.Texts);
    }

    internal static HostModels Catalog(Uri detector, Uri provider)
    {
        var root = new JsonObject
        {
            ["providers"] = new JsonObject
            {
                ["p"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = provider.ToString(),
                    ["textRedaction"] = Settings(detector),
                    ["models"] = new JsonArray("m", "other"),
                },
                ["route"] = new JsonObject
                {
                    ["providerType"] = "failover",
                    ["targets"] = new JsonArray("p/m", "p/other"),
                    ["failureThreshold"] = 1,
                },
            },
        };
        return HostModels.Parse(root, new());
    }
}
