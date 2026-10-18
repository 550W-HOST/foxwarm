using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task LoadMainHostAsync()
    {
        CommittedArchiveIdentity.ValidateStartupEvidence(root, allowPendingIdentityRecovery: true);
        await SqliteOnlyArchivesMigration.RunAsync(root, Journal);
        await EnsureIdentityStartupAsync();
        await agents.BootstrapMainMemoryAsync(hostPaths?.ResourceRoot ?? AppContext.BaseDirectory);
        await LoadOwnersAsync(startMainServices: true);
    }
}
