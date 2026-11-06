using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

/// <summary>
/// Key, access and model-ID rejections end a request promptly with a readable cause, while
/// transient failures and failover keep their retry behavior.
/// </summary>
public sealed class ModelConfigurationFailureTests
{
    private const string Rejected =
        "{\"error\":{\"message\":\"Incorrect API key provided.\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}";

    private static HostModels Catalog(string token = "synthetic-key") =>
        HostModels.Parse(
            JsonNode
                .Parse(
                    """
                    {"default":"a/m","providers":{
                      "a":{"providerType":"openai-responses","baseUrl":"http://localhost/a","apiKey":"TOKEN","models":["m"]},
                      "b":{"providerType":"anthropic","extraFields":{"stream":false},"baseUrl":"http://localhost/b","apiKey":"synthetic-b","models":["m"]},
                      "route":{"providerType":"failover","targets":["a/m","b/m"]},
                      "pool":{"providerType":"session-hash","targets":["a/m"]}
                    }}
                    """.Replace("TOKEN", token)
                )!
                .AsObject(),
            new JsonObject()
        );

    private sealed record Outcome(
        int Calls,
        List<ModelRetryEvent> Events,
        List<int> Delays,
        Exception? Error,
        ModelRouting Routing
    );

    private static async Task<Outcome> Run(
        string routeKey,
        Func<HttpRequestMessage, HttpResponseMessage> respond,
        string token = "synthetic-key"
    )
    {
        var calls = 0;
        var events = new List<ModelRetryEvent>();
        var delays = new List<int>();
        var routing = new ModelRouting();
        using var client = new HttpClient(
            new Handler(
                (request, _) =>
                {
                    calls++;
                    return Task.FromResult(respond(request));
                }
            )
        );
        var owner = new ModelRequestOwner(
            client,
            new(new Uri("http://localhost"), "m", "a/m", "", "", 50),
            routing,
            (milliseconds, _) =>
            {
                delays.Add(milliseconds);
                return Task.CompletedTask;
            }
        );
        var error = await Record.ExceptionAsync(() =>
            owner.RequestAsync(
                "session",
                Catalog(token),
                routeKey,
                null,
                "lineage",
                "turn",
                [],
                (_, _) => Task.FromResult("prompt"),
                value =>
                {
                    events.Add(value);
                    return Task.FromResult(false);
                },
                null,
                null,
                null,
                CancellationToken.None
            )
        );
        return new(calls, events, delays, error, routing);
    }

    private static HttpResponseMessage Status(HttpStatusCode status, string body) =>
        new(status) { Content = new StringContent(body) };

    private static HttpResponseMessage Done(HttpRequestMessage request) =>
        request.RequestUri!.AbsolutePath.EndsWith("/messages", StringComparison.Ordinal)
            ? Status(HttpStatusCode.OK, "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}")
            : Status(
                HttpStatusCode.OK,
                "{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}"
            );

    [Theory]
    [InlineData(401, Rejected, "synthetic-key", "authentication", "The a provider rejected the API key.")]
    [InlineData(401, "{\"error\":{\"message\":\"You didn't provide an API key.\"}}", "", "missing-api-key", "No API key is set for the a provider.")]
    [InlineData(403, "{\"error\":{\"message\":\"Forbidden\"}}", "synthetic-key", "permission", "denied access to the model m.")]
    [InlineData(
        404,
        "{\"error\":{\"message\":\"The model `m` does not exist or you do not have access to it.\",\"code\":\"model_not_found\"}}",
        "synthetic-key",
        "model-not-found",
        "does not recognize the model m."
    )]
    [InlineData(
        400,
        "{\"error\":{\"message\":\"Unknown model.\",\"code\":\"model_not_found\"}}",
        "synthetic-key",
        "model-not-found",
        "does not recognize the model m."
    )]
    public async Task Configuration_rejection_ends_a_concrete_request_after_one_attempt_with_its_cause(
        int status,
        string body,
        string token,
        string cause,
        string explanation
    )
    {
        var outcome = await Run("a/m", _ => Status((HttpStatusCode)status, body), token);
        Assert.Equal(1, outcome.Calls);
        Assert.Empty(outcome.Delays);
        var final = Assert.Single(outcome.Events);
        Assert.True(final.Final);
        Assert.Equal(cause, final.Cause);
        Assert.Contains(explanation, final.Explanation);
        Assert.Equal(cause, final.ToJson()["cause"]!.GetValue<string>());
        var error = Assert.IsType<ModelRequestException>(outcome.Error);
        Assert.Contains(explanation, error.Message);
        Assert.Contains("Check Setup → Models.", error.Message);
        Assert.Contains("Provider response: " + status + ":", error.Message);
        if (token.Length > 0)
            Assert.DoesNotContain(token, error.Message);
    }

    [Fact]
    public void Anthropic_unknown_model_body_is_a_model_ID_failure()
    {
        Assert.Equal(
            "model-not-found",
            ModelAttemptFailure.ConfigurationCause(
                404,
                "{\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: claude-missing\"}}"
            )
        );
        Assert.Null(
            ModelAttemptFailure.ConfigurationCause(
                404,
                "{\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"Not found\"}}"
            )
        );
        Assert.Null(ModelAttemptFailure.ConfigurationCause(503, "overloaded"));
        Assert.Null(ModelAttemptFailure.ConfigurationCause(429, "rate limited"));
    }

    [Fact]
    public async Task Transient_failures_keep_the_six_attempt_backoff_without_a_cause()
    {
        var outcome = await Run("a/m", _ => Status(HttpStatusCode.ServiceUnavailable, "busy"));
        Assert.Equal(6, outcome.Calls);
        Assert.Equal(new[] { 2000, 5000, 10000, 20000, 40000 }, outcome.Delays);
        Assert.All(outcome.Events, value => Assert.Null(value.Cause));
        Assert.Null(outcome.Events[^1].ToJson()["cause"]);
        Assert.StartsWith(
            "API request failed after 6 attempts",
            Assert.IsType<ModelRequestException>(outcome.Error).Message
        );
        var notFound = await Run("a/m", _ => Status(HttpStatusCode.NotFound, "no route"));
        Assert.Equal(6, notFound.Calls);
    }

    [Fact]
    public async Task Failover_moves_past_a_rejected_target_immediately_and_cools_it()
    {
        var outcome = await Run(
            "route",
            request =>
                request.RequestUri!.AbsolutePath.StartsWith("/a/", StringComparison.Ordinal)
                    ? Status(HttpStatusCode.Unauthorized, Rejected)
                    : Done(request)
        );
        Assert.Null(outcome.Error);
        Assert.Equal(2, outcome.Calls);
        var retry = Assert.Single(outcome.Events);
        Assert.False(retry.Final);
        Assert.Equal("authentication", retry.Cause);
        var catalog = Catalog();
        Assert.Equal(
            "b/m",
            outcome
                .Routing.Select(outcome.Routing.Begin("route", catalog.Resolve("route")), "lineage")
                .TargetKey
        );
    }

    [Fact]
    public async Task Rejection_on_the_final_failover_or_a_session_hash_target_ends_the_request()
    {
        var final = await Run("route", _ => Status(HttpStatusCode.Forbidden, "{}"));
        Assert.Equal(2, final.Calls);
        Assert.True(final.Events[^1].Final);
        Assert.Equal("permission", final.Events[^1].Cause);
        Assert.StartsWith("The b provider denied access", final.Error!.Message);
        var pool = await Run("pool", _ => Status(HttpStatusCode.Unauthorized, Rejected));
        Assert.Equal(1, pool.Calls);
        Assert.True(Assert.Single(pool.Events).Final);
    }

    [Fact]
    public void Placeholder_keys_are_recognized_without_rejecting_real_or_local_values()
    {
        foreach (
            var key in new[]
            {
                "your-openai-key",
                "your-openai-api-key",
                "YOUR_API_KEY",
                "replace-with-your-key",
                "replace-me",
                "changeme",
                "sk-...",
                "sk-xxxx",
                "<api key>",
                "paste-your-key-here",
            }
        )
            Assert.True(ModelApiKeys.IsPlaceholder(key), key);
        foreach (var key in new[] { "", "sk-proj-abc123", "ollama", "local", "none" })
            Assert.False(ModelApiKeys.IsPlaceholder(key), key);
        Assert.True(ModelApiKeys.RequiresKey("https://api.openai.com/v1"));
        Assert.True(ModelApiKeys.RequiresKey("https://api.anthropic.com"));
        Assert.True(ModelApiKeys.RequiresKey("https://openrouter.ai/api/v1"));
        Assert.False(ModelApiKeys.RequiresKey("http://127.0.0.1:11434/v1"));
        Assert.False(ModelApiKeys.RequiresKey("https://gateway.example.test/v1"));
        Assert.False(ModelApiKeys.RequiresKey("https://api.openai.com.example.test/v1"));
    }

    [Theory]
    [InlineData(
        "default: openai/m\nproviders:\n  openai:\n    providerType: openai-completions\n    baseUrl: https://api.openai.com/v1\n    apiKey: \"your-openai-api-key\"\n    models: [m]\n",
        "Replace the placeholder API key for the openai provider with your key."
    )]
    [InlineData(
        "default: openai/m\nproviders:\n  openai:\n    providerType: openai-completions\n    baseUrl: https://api.openai.com/v1\n    models: [m]\n",
        "Add an API key for the openai provider."
    )]
    [InlineData(
        "default: claude/m\nproviders:\n  claude:\n    providerType: anthropic\n    baseUrl: https://api.anthropic.com\n    apiKey: \"\"\n    models: [m]\n",
        "Add an API key for the claude provider."
    )]
    public async Task First_run_save_rejects_an_unusable_key_and_leaves_Setup_open(
        string yaml,
        string message
    )
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.SaveAsync(new JsonObject { ["yaml"] = yaml })
        );
        Assert.Equal(message, error.Message);
        Assert.Equal(message, configuration.SafeError(error, new JsonObject { ["yaml"] = yaml }));
        Assert.False(File.Exists(configuration.ActivePath));
        Assert.True(configuration.Diagnostics()["oobe"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Keyless_local_gateways_complete_first_run_and_later_saves_only_report_placeholders()
    {
        using var temp = new TempDirectory();
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] =
                    "default: local/m\nproviders:\n  local:\n    providerType: openai-completions\n    baseUrl: http://127.0.0.1:11434/v1\n    models: [m]\n",
            }
        );
        Assert.False(configuration.Diagnostics()["oobe"]!.GetValue<bool>());
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] =
                    "default: local/m\nproviders:\n  local:\n    providerType: openai-completions\n    baseUrl: http://127.0.0.1:11434/v1\n    models: [m]\n  spare:\n    providerType: anthropic\n    baseUrl: https://api.anthropic.com\n    apiKey: your-anthropic-key\n    models: [c]\n",
            }
        );
        var diagnostics = configuration.Diagnostics();
        Assert.True(diagnostics["hasPlaceholderSecrets"]!.GetValue<bool>());
        Assert.Equal(
            "spare",
            Assert.Single(diagnostics["placeholderProviders"]!.AsArray())!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Legacy_app_fallback_key_counts_as_configured_for_first_run()
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        await File.WriteAllTextAsync(
            Path.Combine(temp.Path, "state", "config.yaml"),
            "llm:\n  openaiApiKey: synthetic-fallback-key\n"
        );
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        await configuration.SaveAsync(
            new JsonObject
            {
                ["yaml"] =
                    "default: openai/m\nproviders:\n  openai:\n    providerType: openai-completions\n    baseUrl: https://api.openai.com/v1\n    models: [m]\n",
            }
        );
        Assert.True(File.Exists(configuration.ActivePath));
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
