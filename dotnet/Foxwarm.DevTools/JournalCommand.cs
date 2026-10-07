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
        using var store = new LlmRequestJournalStore(root);
        await store.InitializeAsync();
        switch (args[1])
        {
            case "export" when args.Length == 3:
                await store.ExportJsonlAsync(args[2]);
                Console.WriteLine(JsonSerializer.Serialize(new { exported = args[2] }));
                break;
            case "import" when args.Length == 3:
                var imported = await store.MigrateLegacyAsync(args[2]);
                if (imported)
                    await store.MarkSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId);
                Console.WriteLine(JsonSerializer.Serialize(new { imported, authority = imported }));
                break;
            case "reconstruct" when args.Length == 3:
                Console.WriteLine(
                    LlmRequestJournalStore.EncodeCli(await store.ReconstructAsync(args[2]))
                );
                break;
            case "list" when args.Length == 2:
                Console.WriteLine(
                    LlmRequestJournalStore.EncodeCli(
                        await store.ListAsync(null, null, null, null, 100)
                    )
                );
                break;
            default:
                throw new ArgumentException(
                    "Usage: journal ROOT <export OUTPUT|import JSONL|reconstruct REQUEST_ID|list>"
                );
        }
    }
}
