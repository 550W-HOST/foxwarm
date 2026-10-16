using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Tools;

namespace Foxwarm.Tests.Models;

public sealed class LlmRequestJournalQualificationTests
{
    [Fact]
    public async Task Attempt_start_is_committed_and_reconstructable_by_an_independent_reader_before_send()
    {
        using var temp = new TempDirectory();
        using var journal = new LlmRequestJournalStore(temp.Path);
        var sends = 0;
        using var client = new HttpClient(new CountingHandler(() =>
        {
            // A separate store/connection observes durable state at the actual transport boundary.
            using var reader = new LlmRequestJournalStore(temp.Path);
            var requests = reader.ListAsync("session", null, null, null, 10).GetAwaiter().GetResult();
            var id = Assert.Single(requests)!["requestId"]!.GetValue<string>();
            var restored = reader.ReconstructAsync(id).GetAwaiter().GetResult();
            Assert.Equal("complete", restored["completeness"]!.GetValue<string>());
            var attempt = Assert.Single(restored["attempts"]!.AsArray());
            Assert.Equal(1, attempt!["start"]!["attempt"]!.GetValue<int>());
            Assert.Null(attempt!["result"]);
            sends++;
        }, "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"));
        var owner = new ModelRequestOwner(client,
            new ResponsesClientOptions(new Uri("http://localhost"), "model", "model", "token", "", 50),
            new ModelRouting(), journal: journal);
        await owner.RequestAsync("session", Catalog("anthropic"), "model", null, "cache", "turn",
            History(), (_, _) => Task.FromResult("prompt"), null, null, null, null, CancellationToken.None);
        Assert.Equal(1, sends);
    }

    [Fact]
    public async Task Journal_preparation_failure_happens_before_provider_send()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-journal-file-" + Guid.NewGuid().ToString("N")
        );
        await File.WriteAllTextAsync(root, "not a directory");
        var calls = 0;
        try
        {
            using var journal = new LlmRequestJournalStore(root);
            using var client = new HttpClient(new CountingHandler(() => calls++));
            var owner = new ModelRequestOwner(
                client,
                new ResponsesClientOptions(
                    new Uri("http://localhost"),
                    "model",
                    "model",
                    "token",
                    "",
                    50
                ),
                new ModelRouting(),
                journal: journal
            );
            await Assert.ThrowsAnyAsync<Exception>(() =>
                owner.RequestAsync(
                    "session",
                    Catalog(),
                    "model",
                    null,
                    "cache",
                    "turn",
                    History(),
                    (_, _) => Task.FromResult("prompt"),
                    null,
                    null,
                    null,
                    null,
                    CancellationToken.None
                )
            );
            Assert.Equal(0, calls);
        }
        finally
        {
            File.Delete(root);
        }
    }

    [Fact]
    public async Task Compaction_diagnostic_is_kept_out_of_request_journal_and_concrete_provider_body()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-journal-compaction-" + Guid.NewGuid().ToString("N")
        );
        try
        {
            using var journal = new LlmRequestJournalStore(root);
            var recorder = new RecordingHandler();
            using var client = new HttpClient(recorder);
            var owner = new ModelRequestOwner(
                client,
                new ResponsesClientOptions(
                    new Uri("http://localhost"),
                    "model",
                    "model",
                    "token",
                    "",
                    50
                ),
                new ModelRouting(),
                journal: journal
            );
            var history = new[]
            {
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "after compact" }),
                    ["compaction"] = new JsonObject
                    {
                        ["planner"] = new JsonObject
                        {
                            ["steps"] = 1,
                            ["toolCalls"] = new JsonArray("submit_compact_plan"),
                            ["messages"] = new JsonArray(),
                        },
                    },
                },
            };
            await owner.RequestAsync(
                "session",
                Catalog("anthropic"),
                "model",
                null,
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                CancellationToken.None
            );
            var listed = await journal.ListAsync("session", "low-level", null, null, 10);
            var request = await journal.ReconstructAsync(
                listed[0]!["requestId"]!.GetValue<string>()
            );
            Assert.DoesNotContain("compaction", request.ToJsonString());
            Assert.DoesNotContain("compaction", recorder.LastBody!);
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, true);
        }
    }

    [Theory]
    [InlineData("normal")]
    [InlineData("guarded-success")]
    [InlineData("guarded-error")]
    public async Task Toolscript_projection_is_shared_by_canonical_journal_and_actual_provider_preparation_without_changing_history(
        string scenario
    )
    {
        using var temp = new TempDirectory();
        using var journal = new LlmRequestJournalStore(temp.Path);
        var recorder = new RecordingHandler();
        using var client = new HttpClient(recorder);
        var owner = new ModelRequestOwner(
            client,
            new ResponsesClientOptions(
                new Uri("http://localhost"),
                "model",
                "model",
                "token",
                "",
                50
            ),
            new ModelRouting(),
            journal: journal
        );
        var history = new[]
        {
            JsonNode
                .Parse(
                    """{"role":"model","parts":[{"functionCall":{"id":"script","name":"run_script","args":{}}}]}"""
                )!
                .AsObject(),
            JsonNode
                .Parse(
                    """{"role":"tool","parts":[{"functionResponse":{"tool_use_id":"script","name":"run_script","response":{"status":"completed","stdout":"printed literal\n","result":false},"__meta":{"toolScriptSubCalls":[]}}}]}"""
                )!
                .AsObject(),
        };
        var native = history[1]["parts"]![0]!["functionResponse"]!["response"]!.AsObject();
        string expected;
        if (scenario != "normal")
        {
            native["stdout"] = new string('x', 41000) + "\n";
            if (scenario == "guarded-error")
            {
                native["status"] = "failed";
                native["error"] = "ValueError: guard-error";
                native.Remove("result");
            }
            var fullText = ToolResponseFormatting.FormatToolScriptExecution(native);
            var guarded = await ToolOutputGuard.GuardAsync(native, temp.Path, "script", true);
            Assert.True(guarded!["outputTruncated"]!.GetValue<bool>());
            Assert.Equal(
                fullText,
                await File.ReadAllTextAsync(guarded["outputFullPath"]!.GetValue<string>())
            );
            if (scenario == "guarded-error")
            {
                Assert.Null(guarded["output"]);
                Assert.StartsWith(
                    "TOOL ERROR OUTPUT TOO LONG\n",
                    guarded["error"]!.GetValue<string>()
                );
            }
            history[1]["parts"]![0]!["functionResponse"]!["response"] = guarded;
            expected = ToolResponseFormatting.Format(guarded);
        }
        else
            expected = ToolResponseFormatting.FormatToolScriptExecution(native);
        var before = history.Select(row => row.ToJsonString()).ToArray();
        await owner.RequestAsync(
            "session",
            Catalog("anthropic"),
            "model",
            null,
            "cache",
            "turn",
            history,
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            CancellationToken.None
        );
        var listed = await journal.ListAsync("session", "low-level", null, null, 10);
        var request = await journal.ReconstructAsync(listed[0]!["requestId"]!.GetValue<string>());
        var text = request["messages"]![1]!["parts"]![0]!["functionResponse"]!["response"]![
            "output"
        ]!.GetValue<string>();
        Assert.Equal(expected, text);
        if (scenario == "normal")
            Assert.StartsWith("--- print ---\nprinted literal\n--- return ---\nfalse\n---\n", text);
        var wire = JsonNode.Parse(recorder.LastBody!)!;
        Assert.Equal(text, wire["messages"]![1]!["content"]![0]!["content"]!.GetValue<string>());
        Assert.DoesNotContain("toolScriptSubCalls", request.ToJsonString());
        Assert.DoesNotContain("toolScriptSubCalls", recorder.LastBody!);
        Assert.Equal(before, history.Select(row => row.ToJsonString()));
    }

    [Fact]
    public async Task Owner_journals_repaired_visible_history_and_source_result_shape()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-journal-owner-" + Guid.NewGuid().ToString("N")
        );
        try
        {
            using var journal = new LlmRequestJournalStore(root);
            using var client = new HttpClient(
                new CountingHandler(
                    () => { },
                    "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                )
            );
            var owner = new ModelRequestOwner(
                client,
                new ResponsesClientOptions(
                    new Uri("http://localhost"),
                    "model",
                    "model",
                    "token",
                    "",
                    50
                ),
                new ModelRouting(),
                journal: journal
            );
            var history = new[]
            {
                new JsonObject
                {
                    ["role"] = "user",
                    ["modelVisible"] = false,
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "hidden" }),
                },
                new JsonObject
                {
                    ["role"] = "model",
                    ["__meta"] = new JsonObject { ["modelId"] = "model", ["llmRequestId"] = "old" },
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = "visible" }),
                },
            };
            await owner.RequestAsync(
                "session",
                Catalog("anthropic"),
                "model",
                null,
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                CancellationToken.None
            );
            var listed = await journal.ListAsync("session", "low-level", null, null, 10);
            var request = await journal.ReconstructAsync(
                listed[0]!["requestId"]!.GetValue<string>()
            );
            Assert.Equal(1, request["messageCount"]!.GetValue<int>());
            Assert.Null(request["messages"]![0]!["__meta"]!["llmRequestId"]);
            Assert.Equal(
                "model",
                request["messages"]![0]!["__meta"]!["modelId"]!.GetValue<string>()
            );
            Assert.Equal(
                "success",
                request["attempts"]![0]!["result"]!["outcome"]!.GetValue<string>()
            );
            Assert.Equal(
                "done",
                request["attempts"]![0]!["result"]!["result"]!["text"]!.GetValue<string>()
            );
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task Retry_budget_continues_but_context_change_starts_a_new_journal_request()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-journal-retry-" + Guid.NewGuid().ToString("N")
        );
        try
        {
            RetryHandler.Calls = 0;
            using var journal = new LlmRequestJournalStore(root);
            using var client = new HttpClient(new RetryHandler());
            var owner = new ModelRequestOwner(
                client,
                new ResponsesClientOptions(
                    new Uri("http://localhost"),
                    "m",
                    "route",
                    "token",
                    "",
                    50
                ),
                new ModelRouting(),
                (_, _) => Task.CompletedTask,
                journal: journal
            );
            var preparationCalls = 0;
            await owner.RequestAsync(
                "session",
                RetryCatalog(),
                "route",
                null,
                "cache",
                "turn",
                History(),
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                CancellationToken.None,
                scope: ModelRequestScope.Canonical,
                prepareRetry: _ =>
                {
                    preparationCalls++;
                    return Task.FromResult<IReadOnlyList<JsonObject>?>(
                        preparationCalls == 1 ? History("changed") : null
                    );
                },
                journalPurpose: "normal-turn"
            );
            var rows = await journal.ListAsync("session", "normal-turn", null, null, 10);
            Assert.Equal(2, rows.Count);
            Assert.NotEqual(
                rows[0]!["requestId"]!.GetValue<string>(),
                rows[1]!["requestId"]!.GetValue<string>()
            );
            var first = await journal.ReconstructAsync(rows[1]!["requestId"]!.GetValue<string>());
            var second = await journal.ReconstructAsync(rows[0]!["requestId"]!.GetValue<string>());
            Assert.Single(first["attempts"]!.AsArray());
            Assert.Equal(2, second["attempts"]!.AsArray().Count);
            Assert.Equal(
                "failure",
                first["attempts"]![0]!["result"]!["outcome"]!.GetValue<string>()
            );
            Assert.Equal(
                "success",
                second["attempts"]![1]!["result"]!["outcome"]!.GetValue<string>()
            );
            Assert.Equal(3, RetryHandler.Calls);
        }
        finally
        {
            RetryHandler.Calls = 0;
            if (Directory.Exists(root))
                Directory.Delete(root, true);
        }
    }

    [Fact]
    public async Task Post_success_journal_failure_does_not_reissue_provider_request()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-journal-post-success-" + Guid.NewGuid().ToString("N")
        );
        var calls = 0;
        try
        {
            using var journal = new LlmRequestJournalStore(root);
            using var client = new HttpClient(
                new DisposeJournalHandler(() => calls++, journal.Dispose)
            );
            var owner = new ModelRequestOwner(
                client,
                new ResponsesClientOptions(
                    new Uri("http://localhost"),
                    "model",
                    "model",
                    "token",
                    "",
                    50
                ),
                new ModelRouting(),
                journal: journal
            );
            var result = await owner.RequestAsync(
                "session",
                Catalog("anthropic"),
                "model",
                null,
                "cache",
                "turn",
                History(),
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                CancellationToken.None
            );
            Assert.Equal(1, calls);
            Assert.NotNull(result.AssistantMessage);
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, true);
        }
    }

    private static HostModels Catalog(string providerType = "openai-responses") =>
        HostModels.Parse(
            JsonNode
                .Parse(
                    $"{{\"default\":\"model\",\"providers\":{{\"model\":{{\"providerType\":\"{providerType}\",{(providerType == "anthropic" ? "\"extraFields\":{\"stream\":false}," : "")}\"baseUrl\":\"http://localhost\",\"apiKey\":\"token\",\"models\":[\"model\"]}}}}}}"
                )!
                .AsObject(),
            new JsonObject()
        );

    private static HostModels RetryCatalog() =>
        HostModels.Parse(
            JsonNode
                .Parse(
                    """
                    {"default":"route","providers":{"a":{"providerType":"anthropic","extraFields":{"stream":false},"baseUrl":"http://localhost/a","apiKey":"token","models":["m"]},"b":{"providerType":"anthropic","extraFields":{"stream":false},"baseUrl":"http://localhost/b","apiKey":"token","models":["m"]},"route":{"providerType":"failover","targets":["a/m","b/m"],"failureThreshold":5,"cooldownMs":1}}}
                    """
                )!
                .AsObject(),
            new JsonObject()
        );

    private static IReadOnlyList<JsonObject> History() =>
        [
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "hello" }),
            },
        ];

    private static IReadOnlyList<JsonObject> History(string text) =>
        [
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            },
        ];

    private sealed class CountingHandler(Action beforeSend, string response = "")
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            beforeSend();
            return Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(response) }
            );
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        internal string? LastBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            LastBody = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                ),
            };
        }
    }

    private sealed class RetryHandler : HttpMessageHandler
    {
        public static int Calls { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            Calls++;
            if (Calls < 3)
                return Task.FromResult(
                    new HttpResponseMessage(HttpStatusCode.TooManyRequests)
                    {
                        Content = new StringContent("synthetic limit"),
                    }
                );
            return Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                    ),
                }
            );
        }
    }

    private sealed class DisposeJournalHandler(Action beforeSend, Action afterRead)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            beforeSend();
            return Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new DisposeAfterReadContent(
                        "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}",
                        afterRead
                    ),
                }
            );
        }
    }

    private sealed class DisposeAfterReadContent(string value, Action afterRead) : HttpContent
    {
        protected override async Task SerializeToStreamAsync(
            Stream stream,
            TransportContext? context
        )
        {
            await stream.WriteAsync(System.Text.Encoding.UTF8.GetBytes(value));
            afterRead();
        }

        protected override bool TryComputeLength(out long length)
        {
            length = System.Text.Encoding.UTF8.GetByteCount(value);
            return true;
        }
    }
}
