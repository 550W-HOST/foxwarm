using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task LoadMainHostAsync()
    {
        await Journal.InitializeAsync();
        var legacyJournal = Path.Combine(root, "state", "llm-request-journal.jsonl");
        if (File.Exists(legacyJournal))
        {
            await Journal.MigrateLegacyAsync(legacyJournal);
            await Journal.MarkSqliteAuthorityAsync(LlmRequestJournalStore.MigrationId);
        }
        CommittedArchiveIdentity.ValidateStartupEvidence(root, allowPendingIdentityRecovery: true);
        await EnsureIdentityStartupAsync();
        await agents.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
        await LoadOwnersAsync(startMainServices: true);
    }
}
