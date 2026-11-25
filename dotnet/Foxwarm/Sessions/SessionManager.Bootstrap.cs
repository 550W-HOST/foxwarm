using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task LoadMainHostAsync()
    {
        Storage.Identities.ValidateStartupEvidence(allowPendingIdentityRecovery: true);
        // Upgrades file-mode data written by earlier versions.
        if (Journal is LlmRequestJournalStore fileJournal)
            await SqliteOnlyArchivesMigration.RunAsync(root, fileJournal);
        await EnsureIdentityStartupAsync();
        await agents.BootstrapMainMemoryAsync(hostPaths?.ResourceRoot ?? AppContext.BaseDirectory);
        await LoadOwnersAsync(startMainServices: true);
    }
}
