using System.Text.Json;
using Foxwarm.Models;

namespace Foxwarm.DevTools;

internal static class JournalCommand
{
    internal static async Task RunAsync(string[] args)
    {
        if (args.Length < 2)
            throw new ArgumentException(
                "Usage: journal ROOT <export OUTPUT|import JSONL|reconstruct REQUEST_ID|list>"
            );
        var root = args[0];
        await using var store = new AsyncDisposableStore(new LlmRequestJournalStore(root));
        await store.Value.InitializeAsync();
        switch (args[1])
        {
            case "export" when args.Length == 3:
                await store.Value.ExportJsonlAsync(args[2]);
                Console.WriteLine(JsonSerializer.Serialize(new { exported = args[2] }));
                break;
            case "import" when args.Length == 3:
                var hash = await store.Value.MigrateLegacyAsync(args[2]);
                await store.Value.MarkSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId);
                Console.WriteLine(
                    JsonSerializer.Serialize(new { imported = hash, authority = true })
                );
                break;
            case "reconstruct" when args.Length == 3:
                Console.WriteLine((await store.Value.ReconstructAsync(args[2])).ToJsonString());
                break;
            case "list" when args.Length == 2:
                Console.WriteLine(
                    (await store.Value.ListAsync(null, null, null, null, 100)).ToJsonString()
                );
                break;
            default:
                throw new ArgumentException(
                    "Usage: journal ROOT <export OUTPUT|import JSONL|reconstruct REQUEST_ID|list>"
                );
        }
    }

    private sealed class AsyncDisposableStore(LlmRequestJournalStore value) : IAsyncDisposable
    {
        internal LlmRequestJournalStore Value { get; } = value;

        public ValueTask DisposeAsync()
        {
            Value.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
