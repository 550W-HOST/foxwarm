using System.Diagnostics;
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

// Regression tests for the delta review of reversible text redaction: failover eligibility
// across requests, configuration failures on the only redacting target, new leaves in the
// set_config guard, and the memoized linear-time literal pass.
public sealed class TextRedactionDeltaRegressionTests(Xunit.Abstractions.ITestOutputHelper output)
{
    private static readonly byte[] Key = Enumerable.Range(9, 32).Select(i => (byte)i).ToArray();

    // Anthropic-shaped provider: answers with a fixed status/body and records request bodies.
    private sealed class Provider : IAsyncDisposable
    {
        private readonly WebApplication app;
        private int requests;
        internal readonly List<string> Bodies = [];

        private Provider(WebApplication app) => this.app = app;

        internal Uri BaseUri => new(app.Urls.Single() + "/v1");
        internal int RequestCount => Volatile.Read(ref requests);

        internal static async Task<Provider> StartAsync(Func<int, (int Status, string Body)> answer)
        {
            var builder = WebApplication.CreateBuilder();
            builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            var app = builder.Build();
            Provider? provider = null;
            app.MapPost(
                "/{**path}",
                async context =>
                {
                    var n = Interlocked.Increment(ref provider!.requests);
                    using var reader = new StreamReader(context.Request.Body);
                    var body = await reader.ReadToEndAsync();
                    lock (provider.Bodies)
                        provider.Bodies.Add(body);
                    var (status, text) = answer(n);
                    context.Response.StatusCode = status;
                    context.Response.ContentType = "application/json";
                    await context.Response.WriteAsync(text);
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

    private static string Answer(string text) =>
        new JsonObject
        {
            ["content"] = new JsonArray(new JsonObject { ["type"] = "text", ["text"] = text }),
            ["stop_reason"] = "end_turn",
        }.ToJsonString();

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

    private static HostModels Route(Uri p, Uri q, Uri? pDetector, Uri? qDetector, int? threshold)
    {
        var route = new JsonObject
        {
            ["providerType"] = "failover",
            ["targets"] = new JsonArray("p", "q"),
        };
        if (threshold is not null)
            route["failureThreshold"] = threshold;
        return HostModels.Parse(
            new JsonObject
            {
                ["providers"] = new JsonObject
                {
                    ["p"] = AnthropicProvider(p, pDetector),
                    ["q"] = AnthropicProvider(q, qDetector),
                    ["route"] = route,
                },
            },
            new()
        );
    }

    private static JsonObject User(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static Task<ChatResult> Send(
        ModelRequestOwner owner,
        HostModels catalog,
        string session,
        string text,
        int maxAttempts,
        List<ModelRetryEvent>? retries = null
    ) =>
        owner.RequestAsync(
            session,
            owner.Capture(catalog, "route", null),
            "cache-" + session,
            "turn",
            [User(text)],
            (_, _) => Task.FromResult(""),
            retries is null
                ? null
                : value =>
                {
                    retries.Add(value);
                    return Task.FromResult(true);
                },
            null,
            null,
            null,
            default,
            maxAttempts: maxAttempts
        );

    private static async Task RespondNames(HttpContext context, string text, params string[] values)
    {
        var entities = new JsonArray();
        foreach (var value in values)
            for (
                var index = text.IndexOf(value, StringComparison.Ordinal);
                index >= 0;
                index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal)
            )
            {
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

    // D1 (P1): when the primary target of a failover route redacts, a later request (here
    // from another Session) never starts on a plain target while the primary cools. It uses
    // the last redacting target instead, within its own retry budget.
    [Fact]
    public async Task Later_requests_keep_redaction_while_the_redacting_primary_cools()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, text) =>
        {
            await RespondNames(context, text, "Alice");
            return true;
        };
        var healthy = false;
        await using var p = await Provider.StartAsync(_ =>
            Volatile.Read(ref healthy)
                ? (200, Answer("protected answer"))
                : (500, """{"error":{"message":"down"}}""")
        );
        await using var q = await Provider.StartAsync(_ => (200, Answer("plain answer")));
        var catalog = Route(p.BaseUri, q.BaseUri, detector.Endpoint, null, 1);
        using var http = ProviderHttpRequest.CreateClient();
        using var keys = new TextRedactionKeys();
        var owner = new ModelRequestOwner(
            http,
            new(p.BaseUri, "m", "p", "", "", 100),
            new(),
            (_, _) => Task.CompletedTask,
            secrets: keys.Secrets
        );
        await Assert.ThrowsAsync<ModelRequestException>(() =>
            Send(owner, catalog, "s1", "My name is Alice, first message.", 2)
        );
        Assert.Equal(2, p.RequestCount);
        // p is cooling now. Request 2 retries p, never q, and fails with p's own failure.
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            Send(owner, catalog, "s2", "My name is Alice, second message.", 2)
        );
        Assert.Equal(("p/m", 2), (error.Final.ModelId, error.Final.Attempt));
        Assert.NotEqual("text-redaction", error.Final.Kind);
        Assert.Equal(4, p.RequestCount);
        Assert.Equal(0, q.RequestCount);
        Assert.All(p.Bodies, body => Assert.DoesNotContain("Alice", body));
        // Still cooling, but p answers again: request 3 goes to p.
        Volatile.Write(ref healthy, true);
        var result = await Send(owner, catalog, "s3", "My name is Alice, third message.", 1);
        Assert.Equal(
            "protected answer",
            result.AssistantMessage!["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal(0, q.RequestCount);
        Assert.All(p.Bodies, body => Assert.DoesNotContain("Alice", body));
    }

    // D2 (P2): a configuration failure on the redacting target ends the request at once with
    // its ordinary explanation when only ineligible alternatives remain; with a redacting
    // alternative the route still fails over.
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Configuration_failure_on_the_only_redacting_target_ends_at_once(
        bool alternativeRedacts
    )
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        await using var p = await Provider.StartAsync(_ =>
            (
                401,
                """{"type":"error","error":{"type":"authentication_error","message":"bad key"}}"""
            )
        );
        await using var q = await Provider.StartAsync(_ => (200, Answer("ok")));
        var catalog = Route(
            p.BaseUri,
            q.BaseUri,
            detector.Endpoint,
            alternativeRedacts ? detector.Endpoint : null,
            null
        );
        using var http = ProviderHttpRequest.CreateClient();
        using var keys = new TextRedactionKeys();
        var owner = new ModelRequestOwner(
            http,
            new(p.BaseUri, "m", "p", "", "", 100),
            new(),
            (_, _) => Task.CompletedTask,
            secrets: keys.Secrets
        );
        var retries = new List<ModelRetryEvent>();
        if (alternativeRedacts)
        {
            await Send(owner, catalog, "s", "hello", 6, retries);
            Assert.Equal((1, 1), (p.RequestCount, q.RequestCount));
            return;
        }
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            Send(owner, catalog, "s", "hello", 6, retries)
        );
        var final = Assert.Single(retries);
        Assert.Equal((1, true, "missing-api-key"), (final.Attempt, final.Final, final.Cause));
        Assert.StartsWith("No API key is set for the p provider.", error.Message);
        Assert.Equal((1, 0), (p.RequestCount, q.RequestCount));
        // The next request on the route starts on the cooling p and ends the same way.
        retries.Clear();
        await Assert.ThrowsAsync<ModelRequestException>(() =>
            Send(owner, catalog, "s2", "hello", 6, retries)
        );
        Assert.Equal((1, true), (Assert.Single(retries).Attempt, retries[0].Final));
        Assert.Equal((2, 0), (p.RequestCount, q.RequestCount));
    }

    private static async Task<ModelConfiguration> Installed(TempDirectory temp, string yaml)
    {
        var configuration = new ModelConfiguration(
            HostPaths.ForDataRoot(temp.Path, environment: _ => null)
        );
        await configuration.SaveAsync(new JsonObject { ["yaml"] = yaml });
        configuration.Secrets.Store.Set("det-key", "synthetic-detector-secret-value-11");
        return configuration;
    }

    private static string? Outcome(ModelConfiguration configuration, string candidate)
    {
        try
        {
            SecretConfigurationChanges.RequireModelWritable(configuration, "models", candidate);
            return null;
        }
        catch (InvalidDataException error)
        {
            return error.Message;
        }
    }

    // D3 (P3): with a referenced detector key at defaults level, set_config may add, split
    // and rename models whose endpoint and key come unchanged from existing layers. A new
    // leaf that points the key at a new endpoint is still refused.
    [Theory]
    [InlineData("true")]
    [InlineData("false")]
    public async Task New_leaves_inheriting_an_existing_detector_route_are_allowed(string enabled)
    {
        using var temp = new TempDirectory();
        var installed = $$"""
            defaults:
              textRedaction: {enabled: {{enabled}}, endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:det-key}'}
            providers:
              a: {baseUrl: 'http://127.0.0.1:2', apiKey: literal-a, models: [x]}
            """;
        var configuration = await Installed(temp, installed);
        foreach (
            var candidate in new[]
            {
                installed
                    + "\n  b: {baseUrl: 'http://127.0.0.1:3', apiKey: literal-b, models: [m]}\n",
                installed.Replace("models: [x]", "models: [x, y]", StringComparison.Ordinal),
                installed.Replace("models: [x]", "models: [x2]", StringComparison.Ordinal),
                installed.Replace(
                    "models: [x]",
                    "models: [x, {id: y, textRedaction: {enabled: false}}]",
                    StringComparison.Ordinal
                ),
                installed.Replace(
                    "models: [x]",
                    "models: [x], contextLimit: 100000",
                    StringComparison.Ordinal
                ),
            }
        )
            Assert.Null(Outcome(configuration, candidate));
        foreach (
            var candidate in new[]
            {
                installed
                    + "\n  b: {baseUrl: 'http://127.0.0.1:3', apiKey: literal-b, models: [m], textRedaction: {endpoint: 'http://collector.example/c'}}\n",
                installed.Replace(
                    "models: [x]",
                    "models: [x, {id: y, textRedaction: {enabled: false, endpoint: 'http://collector.example/c'}}]",
                    StringComparison.Ordinal
                ),
            }
        )
            Assert.Equal(
                string.Format(
                    SecretConfigurationChanges.SetConfigDenied,
                    candidate.Contains("b: {", StringComparison.Ordinal)
                        ? "text redaction for model b/m"
                        : "text redaction for model a/y"
                ),
                Outcome(configuration, candidate)
            );
    }

    // P4: redirection variants stay refused; edits that cannot redirect the key stay allowed.
    [Fact]
    public async Task Detector_key_redirection_variants_stay_refused()
    {
        using var temp = new TempDirectory();
        const string installed = """
            defaults:
              textRedaction: {endpoint: 'http://127.0.0.1:1/classify', apiKey: '${secret:det-key}'}
            providers:
              a:
                baseUrl: 'http://127.0.0.1:2'
                apiKey: literal-a
                textRedaction: {enabled: true}
                models: [x]
              plain: {baseUrl: 'http://127.0.0.1:4', apiKey: literal-p, models: [z]}
              route: {providerType: failover, targets: [a/x, plain/z]}
            """;
        var configuration = await Installed(temp, installed);
        string Edit(string from, string to) =>
            installed.Replace(from, to, StringComparison.Ordinal);
        const string collector = "endpoint: 'http://collector.example/c'";
        const string enabledOnly = "textRedaction: {enabled: true}";
        var refused = new[]
        {
            Edit("127.0.0.1:1/classify", "collector.example/c"),
            Edit(enabledOnly, "textRedaction: {enabled: true, " + collector + "}"),
            Edit("models: [x]", "models: [{id: x, textRedaction: {" + collector + "}}]"),
            Edit("models: [x]", "model: [{id: x, textRedaction: {" + collector + "}}]"),
            Edit("models: [x]", "model: x")
                .Replace(
                    enabledOnly,
                    "textRedaction: {enabled: true, " + collector + "}",
                    StringComparison.Ordinal
                ),
            Edit("providers:", "models:")
                .Replace("127.0.0.1:1/classify", "collector.example/c", StringComparison.Ordinal),
            installed
                + "\n  evil: {baseUrl: 'http://127.0.0.1:5', apiKey: x, textRedaction: {enabled: true, "
                + collector
                + "}}\n",
            installed
                + "\n  a/x: {baseUrl: 'http://127.0.0.1:5', apiKey: x, textRedaction: {enabled: true, "
                + collector
                + "}}\n",
            Edit(enabledOnly, "textRedaction: false"),
            Edit(enabledOnly, "textRedaction: {enabled: true, apiKey: ''}"),
            Edit(
                "models: [z]}",
                "models: [z], textRedaction: {apiKey: '', enabled: true, " + collector + "}}"
            ),
            Edit("http://127.0.0.1:1/classify", "HTTP://127.0.0.1:1/classify"),
        };
        foreach (var candidate in refused)
            Assert.NotNull(Outcome(configuration, candidate));
        var allowed = new[]
        {
            Edit("targets: [a/x, plain/z]", "targets: [plain/z, a/x]"),
            Edit(enabledOnly, "textRedaction: {enabled: true, threshold: 1}"),
            Edit(
                enabledOnly,
                "textRedaction: {enabled: true, excludeLabels: [private_person, private_email, private_phone, private_address, account_number, secret]}"
            ),
        };
        foreach (var candidate in allowed)
            Assert.Null(Outcome(configuration, candidate));
    }

    // D6 (P5): the approved word-boundary rule, including its documented misses.
    [Fact]
    public async Task Literal_masking_keeps_the_word_boundary_rule()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        string[] seeded = ["13812345678", "alice", "张三", "Ann Lee", "Lee Smith", "O'Neil"];
        detector.Intercept = async (context, text) =>
        {
            await RespondNames(
                context,
                text,
                text.StartsWith("SEED", StringComparison.Ordinal) ? seeded : []
            );
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var redactor = new TextRedactor(Key);
        string P(string value) => redactor.Placeholder(Encoding.UTF8.GetBytes(value));
        await redactor
            .Begin(http, options, default)
            .RedactAsync("SEED 13812345678 alice 张三 Ann Lee and Lee Smith O'Neil");
        var scope = redactor.Begin(http, options, default);
        var cases = new Dictionary<string, string>
        {
            ["call +8613812345678 or 13812345678"] = "call +8613812345678 or " + P("13812345678"),
            ["tel:13812345678x"] = "tel:13812345678x",
            ["user alice2024 / alice_bot / ALICE / Alice / alice."] =
                $"user alice2024 / {P("alice")}_bot / ALICE / Alice / {P("alice")}.",
            ["张三丰 and 张三"] = $"{P("张三")}丰 and {P("张三")}",
            ["Ann Lee Smith"] = P("Ann Lee") + " Smith",
            ["O'Neil's"] = P("O'Neil") + "'s",
            ["see " + P("alice") + "alice and [[FW_SECRET:alice]]"] =
                "see " + P("alice") + P("alice") + " and [[FW_SECRET:alice]]",
        };
        foreach (var (input, expected) in cases)
            Assert.Equal(expected, await scope.RedactAsync(input));
    }

    // D4: the automaton finds the same spans as a direct leftmost-longest search.
    [Fact]
    public void Literal_matcher_agrees_with_a_direct_search()
    {
        var random = new Random(7);
        const string alphabet = "ab1 _x";
        string Text(int length) =>
            new(
                Enumerable
                    .Range(0, length)
                    .Select(_ => alphabet[random.Next(alphabet.Length)])
                    .ToArray()
            );
        var excluded = new[] { "private_date" };
        for (var round = 0; round < 40; round++)
        {
            var redactor = new TextRedactor(Key);
            var originals = Enumerable
                .Range(0, 30)
                .Select(_ => Text(random.Next(2, 7)))
                .Where(value => value.Trim().Length > 0)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            var labels = originals.ToDictionary(
                value => value,
                _ => random.Next(5) == 0 ? "private_date" : "private_person",
                StringComparer.Ordinal
            );
            foreach (var value in originals)
                Assert.True(
                    redactor.TryRegister(
                        redactor.Placeholder(Encoding.UTF8.GetBytes(value)),
                        value,
                        [labels[value]]
                    )
                );
            var text = Text(300);
            var actual = redactor
                .FindKnown(redactor.KnownSnapshot(), text, excluded)
                .Select(found => (found.Start, found.Original))
                .ToArray();
            var expected = new List<(int, string)>();
            var ordered = originals
                .Where(value => labels[value] != "private_date")
                .OrderByDescending(value => value.Length)
                .ToArray();
            for (var index = 0; index < text.Length; )
            {
                var match = ordered.FirstOrDefault(value =>
                    string.CompareOrdinal(text, index, value, 0, value.Length) == 0
                    && index + value.Length <= text.Length
                    && Bounded(text, index, value.Length)
                );
                if (match is null)
                {
                    index++;
                    continue;
                }
                expected.Add((index, match));
                index += match.Length;
            }
            Assert.Equal(expected, actual);
        }

        static bool Bounded(string text, int start, int length)
        {
            static bool Word(char value) => char.IsAsciiLetterOrDigit(value);
            var end = start + length;
            return !(Word(text[start]) && start > 0 && Word(text[start - 1]))
                && !(Word(text[end - 1]) && end < text.Length && Word(text[end]));
        }
    }

    // D4 (P6): a long history whose words share prefixes with many known originals is
    // scanned in time linear in its length. Before the automaton this case took minutes.
    [Fact]
    public void Literal_pass_stays_linear_for_clustered_histories()
    {
        var redactor = new TextRedactor(Key);
        string[] firsts = ["Ma", "Ja", "Jo", "Ch", "Da", "Sa", "An", "Mi", "Li", "Ka"];
        string Original(int i) => firsts[i % firsts.Length] + "rk" + i.ToString("x") + " Person";
        for (var i = 0; i < 80000; i++)
        {
            var original = Original(i);
            redactor.TryRegister(
                redactor.Placeholder(Encoding.UTF8.GetBytes(original)),
                original,
                ["private_person"]
            );
        }
        // Every word shares a prefix with thousands of originals; one in 50 is one of them.
        string[] words =
        [
            "Mark",
            "James",
            "John",
            "Chat",
            "Data",
            "Same",
            "And",
            "Michael",
            "Link",
            "Karl",
            "the",
            "of",
            "work",
            "markdown",
        ];
        var random = new Random(1);
        var history = Enumerable
            .Range(0, 1000)
            .Select(_ =>
            {
                var builder = new StringBuilder();
                while (builder.Length < 2000)
                    builder
                        .Append(
                            random.Next(50) == 0
                                ? Original(random.Next(80000))
                                : words[random.Next(words.Length)]
                        )
                        .Append(' ');
                return builder.ToString();
            })
            .ToArray();
        using var http = new HttpClient();
        var scope = new TextRedactionScope(
            redactor,
            http,
            new TextRedactionOptions(new("http://127.0.0.1:1/c"), null, 0.5, 30000),
            default
        );
        var watch = Stopwatch.StartNew();
        var masked = history.Select(scope.MaskKnown).ToArray();
        watch.Stop();
        output.WriteLine($"literal pass: {watch.ElapsedMilliseconds} ms");
        Assert.All(masked, text => Assert.Contains(TextRedactor.Prefix, text));
        Assert.All(masked, text => Assert.DoesNotContain(" Person", text));
        // 2,000,000 characters against 80,000 originals; the old scan needed over a minute.
        Assert.InRange(watch.ElapsedMilliseconds, 0, 15000);
    }

    // F3 (P7): a retried attempt restores what it registered itself, also when the slot's
    // result comes from the first attempt's memoized passes.
    [Fact]
    public async Task Retry_attempt_restores_placeholders_of_memoized_slots()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, text) =>
        {
            await RespondNames(context, text, "Alice");
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        using var keys = new TextRedactionKeys();
        var placeholder = TextRedactor
            .For(keys.Secrets.TextRedactionPlaceholderKey())
            .Placeholder(Encoding.UTF8.GetBytes("Alice"));
        await using var p = await Provider.StartAsync(n =>
            n == 1 ? (500, """{"error":{"message":"down"}}""") : (200, Answer("Hi " + placeholder))
        );
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["providers"] = new JsonObject
                {
                    ["p"] = AnthropicProvider(p.BaseUri, detector.Endpoint),
                },
            },
            new()
        );
        var owner = new ModelRequestOwner(
            http,
            new(p.BaseUri, "m", "p/m", "", "", 100),
            new(),
            (_, _) => Task.CompletedTask,
            secrets: keys.Secrets
        );
        var result = await owner.RequestAsync(
            "s",
            catalog,
            "p/m",
            null,
            "cache",
            "turn",
            [User("I am Alice")],
            (_, _) => Task.FromResult(""),
            null,
            null,
            null,
            null,
            default
        );
        Assert.Equal(2, p.RequestCount);
        Assert.Equal(p.Bodies[0], p.Bodies[1]);
        Assert.All(p.Bodies, body => Assert.DoesNotContain("Alice", body));
        Assert.Equal(
            "Hi Alice",
            result.AssistantMessage!["parts"]![0]!["text"]!.GetValue<string>()
        );
    }

    // D5 (P8): an unchanged cached slot is sent the same way after another request registers
    // an original it contains, while a new slot still gets that original masked.
    [Fact]
    public async Task Unchanged_slots_keep_their_form_after_other_registrations()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, text) =>
        {
            await RespondNames(
                context,
                text,
                text.StartsWith("Contact:", StringComparison.Ordinal) ? ["Bob"] : []
            );
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient();
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000);
        var redactor = new TextRedactor(Enumerable.Range(60, 32).Select(i => (byte)i).ToArray());
        var bob = redactor.Placeholder("Bob"u8);
        JsonObject[] History() =>
            [
                User("Please ask Bob about the build."),
                new JsonObject
                {
                    ["role"] = "model",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionCall"] = new JsonObject
                            {
                                ["name"] = "write",
                                ["args"] = new JsonObject { ["content"] = "notes for Bob" },
                                ["rawArgsText"] = """{"content":"notes for Bob"}""",
                            },
                        }
                    ),
                },
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionResponse"] = new JsonObject
                            {
                                ["name"] = "write",
                                ["response"] = new JsonObject { ["output"] = "Bob's file written" },
                            },
                        }
                    ),
                },
            ];
        async Task<string> Request(JsonObject[] history)
        {
            // The same two passes as TextRedactionChatService.
            var scope = redactor.Begin(http, options, default);
            await TextRedactionProjection.RedactHistoryAsync(history, scope.DetectAsync);
            await TextRedactionProjection.RedactHistoryAsync(
                history,
                text => Task.FromResult(scope.MaskKnown(text))
            );
            return new JsonArray(
                history.Select(row => (JsonNode)row.DeepClone()).ToArray()
            ).ToJsonString();
        }
        var first = await Request(History());
        Assert.DoesNotContain(bob, first);
        var detections = detector.Texts.Count;
        await redactor.Begin(http, options, default).RedactAsync("Contact: Bob");
        Assert.Equal(first, await Request(History()));
        Assert.Equal(detections + 1, detector.Texts.Count);
        // A slot that was never sent is still masked by the literal pass.
        var extended = History().Append(User("Bob replied.")).ToArray();
        var third = await Request(extended);
        Assert.Contains(bob + " replied.", third);
        Assert.StartsWith(first[..^1], third);
    }
}
