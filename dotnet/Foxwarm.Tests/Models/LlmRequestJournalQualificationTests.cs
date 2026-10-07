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

    private static HostModels Catalog(string providerType = "openai-responses") =>
        HostModels.Parse(
            JsonNode
                .Parse(
                    $"{{\"default\":\"model\",\"providers\":{{\"model\":{{\"providerType\":\"{providerType}\",\"baseUrl\":\"http://localhost\",\"apiKey\":\"token\",\"models\":[\"model\"]}}}}}}"
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
}
