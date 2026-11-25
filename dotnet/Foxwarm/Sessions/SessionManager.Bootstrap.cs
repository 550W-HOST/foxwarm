using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task LoadMainHostAsync()
    {
        Storage.Identities.ValidateStartupEvidence(allowPendingIdentityRecovery: true);
        await SqliteOnlyArchivesMigration.RunAsync(root, Journal);
        await EnsureIdentityStartupAsync();
        await agents.BootstrapMainMemoryAsync(hostPaths?.ResourceRoot ?? AppContext.BaseDirectory);
        await LoadOwnersAsync(startMainServices: true);
    }
}
