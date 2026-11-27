using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Http;

namespace Foxwarm.Tests;

public sealed class TextRedactionConcurrencyTests
{
    [Fact]
    public async Task Concurrent_literal_passes_send_and_register_the_first_memoized_result()
    {
        await using var detector = await TextDetectionPeer.StartAsync();
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        using var redactor = new TextRedactor(
            TextRedactionTests.Key,
            knownLabels: TextRedactionKnownLabels.All
        );
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        var first = redactor.Begin(http, options, default);
        var second = redactor.Begin(http, options, default);
        var firstDetected = await first.DetectAsync("Alice Bob");
        var secondDetected = await second.DetectAsync("Alice Bob");
        redactor.TryRegister(redactor.Placeholder("Alice"u8), "Alice", ["secret"]);
        var winner = first.MaskKnown(firstDetected);
        redactor.TryRegister(redactor.Placeholder("Bob"u8), "Bob", ["secret"]);
        Assert.Equal(winner, second.MaskKnown(secondDetected));
        Assert.Equal("Alice Bob", second.Restore(winner));
        Assert.Equal(winner, await redactor.Begin(http, options, default).RedactAsync("Alice Bob"));
    }

    [Fact]
    public async Task Concurrent_context_dependent_batches_use_one_tool_slot_form_and_restore_it()
    {
        const string table = "Project Lines\ndotnet/UnitChecks 42";
        var held = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, text) =>
        {
            var first = text.Contains("variant-one", StringComparison.Ordinal);
            if (first)
            {
                held.TrySetResult();
                await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
            }
            var original = first ? "UnitChecks" : "/UnitChecks";
            var start = text.IndexOf(original, StringComparison.Ordinal);
            var entities = new JsonArray();
            if (start >= 0)
            {
                var bytes = Encoding.UTF8.GetByteCount(text[..start]);
                entities.Add(
                    new JsonObject
                    {
                        ["start"] = bytes,
                        ["end"] = bytes + original.Length,
                        ["label"] = "private_name",
                        ["score"] = 0.99,
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
            return true;
        };
        var forms = new List<string>();
        await using var provider = new ScriptedResponsesSequenceServer(
            3,
            async (_, connection, request) =>
            {
                var body = JsonNode.Parse(request.Body)!;
                var blocks = body["messages"]!
                    .AsArray()
                    .SelectMany(message => message!["content"] as JsonArray ?? [])
                    .OfType<JsonObject>();
                var output = blocks.Single(block =>
                    SessionWait.Text(block["type"]) == "tool_result"
                )["content"]!.GetValue<string>();
                lock (forms)
                    forms.Add(output);
                var key = Regex.Match(output, @"\[\[PRIVATE_[0-9a-f]{16}\]\]").Value;
                await LoopbackResponsesServer.WriteResponseAsync(
                    connection,
                    200,
                    "application/json",
                    Encoding.UTF8.GetBytes(
                        new JsonObject
                        {
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "text", ["text"] = key }
                            ),
                            ["stop_reason"] = "end_turn",
                        }.ToJsonString()
                    )
                );
            }
        );
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["defaults"] = new JsonObject
                {
                    ["textRedaction"] = new JsonObject { ["knownLabels"] = "all" },
                },
                ["providers"] = new JsonObject
                {
                    ["p"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = provider.BaseUri.ToString(),
                        ["models"] = new JsonArray("m"),
                        ["extraFields"] = new JsonObject { ["stream"] = false },
                        ["textRedaction"] = new JsonObject
                        {
                            ["enabled"] = true,
                            ["endpoint"] = detector.Endpoint.ToString(),
                            ["batchBytes"] = 65536,
                            ["maxConcurrency"] = 4,
                        },
                    },
                },
            },
            new()
        );
        var history = new[]
        {
            new JsonObject
            {
                ["role"] = "model",
                ["__meta"] = new JsonObject { ["modelId"] = "p/m" },
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionCall"] = new JsonObject
                        {
                            ["id"] = "call",
                            ["name"] = "count",
                            ["args"] = new JsonObject(),
                        },
                    }
                ),
            },
            new JsonObject
            {
                ["role"] = "tool",
                ["parts"] = new JsonArray(
                    new JsonObject
                    {
                        ["functionResponse"] = new JsonObject
                        {
                            ["tool_use_id"] = "call",
                            ["name"] = "count",
                            ["response"] = new JsonObject { ["output"] = table },
                        },
                    }
                ),
            },
        };
        using var root = new TempDirectory();
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        async Task<ChatResult> Request(InstanceSecrets secrets, string instructions)
        {
            var owner = TestModelOwners.Create(
                http,
                new(provider.BaseUri, "m", "p/m", "", "", 100, null),
                new(),
                secrets: secrets
            );
            return await owner.RequestAsync(
                "s",
                owner.Capture(catalog, "p/m", null),
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult(instructions),
                null,
                null,
                null,
                null,
                default,
                maxAttempts: 1
            );
        }
        using (var secrets = TextRedactionKeys.AllLabels(root.Path))
        {
            var losing = Request(secrets, "variant-one");
            await held.Task.WaitAsync(TimeSpan.FromSeconds(15));
            ChatResult winning;
            try
            {
                winning = await Request(secrets, "variant-two");
            }
            finally
            {
                release.TrySetResult();
            }
            var loser = await losing;
            Assert.Equal(
                "/UnitChecks",
                SessionWait.Text(winning.AssistantMessage!["parts"]![0]!["text"])
            );
            Assert.Equal(
                "/UnitChecks",
                SessionWait.Text(loser.AssistantMessage!["parts"]![0]!["text"])
            );
            Assert.Equal(forms[0], forms[1]);
        }
        var calls = detector.Texts.Count;
        using (var restarted = TextRedactionKeys.AllLabels(root.Path))
            await Request(restarted, "variant-two");
        Assert.Equal(calls, detector.Texts.Count);
        Assert.Equal(forms[0], forms[2]);
    }

    [Fact]
    public async Task Concurrent_detection_and_literal_cache_cannot_create_an_unrestored_nested_placeholder()
    {
        using var keys = new TextRedactionKeys(allLabels: true);
        var redactor = keys.Secrets.TextRedactor();
        const string prefix = "prefix-value ";
        const string name = "UnitChecks";
        var nameKey = redactor.Placeholder(Encoding.UTF8.GetBytes(name));
        // A short known hex value is ordinary input. Its position after the second
        // classification aligns with the same characters inside the first placeholder.
        var literal = nameKey.Substring(nameKey.Length - prefix.Length, 2);
        var text = prefix + name + " " + literal + "!";
        var firstSeen = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstCached = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        var call = 0;
        await using var detector = await TextDetectionPeer.StartAsync();
        detector.Intercept = async (context, input) =>
        {
            var number = Interlocked.Increment(ref call);
            if (number == 1)
            {
                firstSeen.TrySetResult();
                await release.Task.WaitAsync(TimeSpan.FromSeconds(15));
            }
            if (number == 2)
                await firstCached.Task.WaitAsync(TimeSpan.FromSeconds(15));
            var start = number == 1 ? prefix.Length : 0;
            var end = prefix.Length + name.Length + (number == 1 ? 0 : 1);
            await context.Response.WriteAsJsonAsync(
                new JsonObject
                {
                    ["entities"] = new JsonArray(
                        new JsonObject
                        {
                            ["start"] = start,
                            ["end"] = end,
                            ["label"] = "private_name",
                            ["score"] = 0.99,
                        }
                    ),
                    ["offset_unit"] = "utf8_bytes",
                    ["input_bytes"] = Encoding.UTF8.GetByteCount(input),
                    ["input_tokens"] = input.Length,
                }
            );
            return true;
        };
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        redactor.TryRegister(
            redactor.Placeholder(Encoding.UTF8.GetBytes(literal)),
            literal,
            ["secret"]
        );
        var first = redactor.Begin(http, options, default);
        var second = redactor.Begin(http, options, default);
        var pendingFirst = first.DetectAsync(text);
        await firstSeen.Task.WaitAsync(TimeSpan.FromSeconds(15));
        // This call passes the empty-cache check before waiting in the endpoint queue.
        var pendingSecond = second.DetectAsync(text);
        release.TrySetResult();
        var detectedFirst = await pendingFirst;
        firstCached.TrySetResult();
        var detectedSecond = await pendingSecond;
        second.MaskKnown(detectedSecond);
        first.MaskKnown(detectedFirst);

        string? sent = null;
        await using var provider = new LoopbackResponsesServer(
            async (connection, request) =>
            {
                sent = JsonNode.Parse(request.Body)!["messages"]![0]![
                    "content"
                ]!.GetValue<string>();
                await LoopbackResponsesServer.WriteResponseAsync(
                    connection,
                    200,
                    "application/json",
                    Encoding.UTF8.GetBytes(
                        new JsonObject
                        {
                            ["content"] = new JsonArray(
                                new JsonObject { ["type"] = "text", ["text"] = sent }
                            ),
                            ["stop_reason"] = "end_turn",
                        }.ToJsonString()
                    )
                );
            }
        );
        var catalog = HostModels.Parse(
            new JsonObject
            {
                ["defaults"] = new JsonObject
                {
                    ["textRedaction"] = new JsonObject { ["knownLabels"] = "all" },
                },
                ["providers"] = new JsonObject
                {
                    ["p"] = new JsonObject
                    {
                        ["providerType"] = "anthropic",
                        ["baseUrl"] = provider.BaseUri.ToString(),
                        ["models"] = new JsonArray("m"),
                        ["extraFields"] = new JsonObject { ["stream"] = false },
                        ["textRedaction"] = TextRedactionTests.Settings(detector.Endpoint),
                    },
                },
            },
            new()
        );
        var owner = TestModelOwners.Create(
            http,
            new(provider.BaseUri, "m", "p/m", "", "", 100, null),
            new(),
            secrets: keys.Secrets
        );
        var result = await owner.RequestAsync(
            "s",
            owner.Capture(catalog, "p/m", null),
            "cache",
            "turn",
            [
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
                },
            ],
            (_, _) => Task.FromResult(""),
            null,
            null,
            null,
            null,
            default,
            maxAttempts: 1
        );
        Assert.Equal(text, SessionWait.Text(result.AssistantMessage!["parts"]![0]!["text"]));
        Assert.DoesNotContain(
            nameKey[..(nameKey.Length - prefix.Length)] + TextRedactor.Prefix,
            sent
        );
        Assert.Equal(2, call);
    }

    [Fact]
    public async Task A_literal_input_equal_to_a_cached_form_does_not_change_that_cached_occurrence()
    {
        await using var detector = await TextDetectionPeer.StartAsync("Alice");
        using var http = ProviderHttpRequest.CreateClient(Foxwarm.Net.EgressPolicy.Unguarded);
        using var redactor = new TextRedactor(
            TextRedactionTests.Key,
            knownLabels: TextRedactionKnownLabels.All
        );
        var options = new TextRedactionOptions(detector.Endpoint, null, 0.5, 30000)
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        var original = "Alice Bob";
        var first = await redactor.Begin(http, options, default).RedactAsync(original);
        redactor.TryRegister(redactor.Placeholder("Bob"u8), "Bob", ["secret"]);
        var scope = redactor.Begin(http, options, default);
        var cached = await scope.DetectAsync(original);
        var literal = await scope.DetectAsync(first);
        Assert.Equal(cached, literal);
        Assert.Equal(first, scope.MaskKnown(cached));
        Assert.DoesNotContain("Bob", scope.MaskKnown(literal));
    }

    [Fact]
    public void An_evicted_detection_cannot_memoize_literal_offsets_into_a_new_detection()
    {
        using var redactor = new TextRedactor(
            TextRedactionTests.Key,
            cacheBytes: 500,
            knownLabels: TextRedactionKnownLabels.All
        );
        var options = new TextRedactionOptions(
            new Uri("http://127.0.0.1:1/classify"),
            null,
            0.5,
            30000
        )
        {
            KnownLabels = TextRedactionKnownLabels.All,
        };
        const string text = "Alice Bob";
        var digest = TextRedactor.Digest(text);
        var first = new[]
        {
            new TextRedactor.Found(0, 5, redactor.Placeholder("Alice"u8), "Alice", ["secret"]),
        };
        var second = new[]
        {
            new TextRedactor.Found(
                0,
                text.Length,
                redactor.Placeholder(Encoding.UTF8.GetBytes(text)),
                text,
                ["secret"]
            ),
        };
        redactor.Cache(options, digest, first);
        redactor.Cache(options, TextRedactor.Digest("other"), []);
        redactor.Cache(options, digest, second);
        var literal = new[]
        {
            new TextRedactor.Found(
                first[0].Placeholder.Length + 1,
                3,
                redactor.Placeholder("Bob"u8),
                "Bob",
                ["secret"]
            ),
        };
        redactor.Memoize(options, digest, first, literal);
        var cached = redactor.Peek(options, text)!.Value;
        Assert.Same(second, cached.Spans);
        Assert.Null(cached.Masked);
    }
}
