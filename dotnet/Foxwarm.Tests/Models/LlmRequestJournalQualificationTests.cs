using System.Net;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests.Models;

public sealed class LlmRequestJournalQualificationTests
{
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
                    $"{{\"default\":\"model\",\"providers\":{{\"model\":{{\"providerType\":\"{providerType}\",\"baseUrl\":\"http://localhost\",\"apiKey\":\"token\",\"models\":[\"model\"]}}}}}}"
                )!
                .AsObject(),
            new JsonObject()
        );

    private static HostModels RetryCatalog() =>
        HostModels.Parse(
            JsonNode
                .Parse(
                    """
                    {"default":"route","providers":{"a":{"providerType":"anthropic","baseUrl":"http://localhost/a","apiKey":"token","models":["m"]},"b":{"providerType":"anthropic","baseUrl":"http://localhost/b","apiKey":"token","models":["m"]},"route":{"providerType":"failover","targets":["a/m","b/m"],"failureThreshold":5,"cooldownMs":1}}}
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
