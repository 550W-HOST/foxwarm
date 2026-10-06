using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests.Models;

public sealed class LlmRequestJournalTests
{
    [Fact]
    public async Task Stores_delta_reconstructs_attempts_and_exports_imports()
    {
        var root = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-journal-test-" + Guid.NewGuid().ToString("N")
        );
        var importedRoot = Path.Combine(
            Path.GetTempPath(),
            "foxwarm-journal-import-" + Guid.NewGuid().ToString("N")
        );
        var export = Path.Combine(root, "export.jsonl");
        try
        {
            using var store = new LlmRequestJournalStore(root);
            var messages = new[]
            {
                new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject { ["text"] = "Hello NBSP\u00a0😀\uD83D" }
                    ),
                },
            };
            var first = await store.BeginRequestAsync(
                "session-1",
                "normal-turn",
                0,
                "System",
                new JsonArray(),
                messages,
                "model-a",
                "cache-a"
            );
            await store.AppendAttemptStartAsync(
                first,
                1,
                "model-a",
                null,
                "responses",
                new JsonObject { ["input"] = messages[0] },
                "System"
            );
            await store.AppendAttemptResultAsync(
                first,
                1,
                "success",
                new JsonObject { ["text"] = "ok" },
                null
            );
            var second = await store.BeginRequestAsync(
                "session-1",
                "normal-turn",
                0,
                "System",
                new JsonArray(),
                new[]
                {
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(
                            new JsonObject { ["text"] = "Hello NBSP\u00a0😀 again" }
                        ),
                    },
                },
                "model-a",
                "cache-b"
            );

            var reconstructed = await store.ReconstructAsync(first);
            Assert.Equal("complete", reconstructed["completeness"]?.GetValue<string>());
            Assert.Equal(
                "Hello NBSP\u00a0😀\uD83D",
                reconstructed["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>()
            );
            Assert.Single(reconstructed["attempts"]!.AsArray());
            var page = await store.ListAsync("session-1", "normal-turn", null, null, 10);
            Assert.Equal(second, page[0]!["requestId"]!.GetValue<string>());
            Assert.Equal(first, page[1]!["requestId"]!.GetValue<string>());

            await store.ExportJsonlAsync(export);
            Assert.True(File.Exists(export));
            using var imported = new LlmRequestJournalStore(importedRoot);
            Assert.NotNull(await imported.MigrateLegacyAsync(export));
            await imported.MarkSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId);
            Assert.True(await imported.HasSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId));
            var importedRequest = await imported.ReconstructAsync(first);
            Assert.Equal("complete", importedRequest["completeness"]?.GetValue<string>());
            Assert.Equal(
                "Hello NBSP\u00a0😀\uD83D",
                importedRequest["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>()
            );
        }
        finally
        {
            if (Directory.Exists(root))
                Directory.Delete(root, true);
            if (Directory.Exists(importedRoot))
                Directory.Delete(importedRoot, true);
        }
    }
}
