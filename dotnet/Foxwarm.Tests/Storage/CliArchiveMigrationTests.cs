using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class CliArchiveMigrationTests
{
    private static async Task Migrate(string root)
    {
        await using var journal = new LlmRequestJournalStore(root);
        await SqliteOnlyArchivesMigration.RunAsync(root, journal);
    }

    private static string Database(string root) => Path.Combine(root, "state/archive-store.sqlite");
}
