namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task LoadMainHostAsync()
    {
        CommittedArchiveIdentity.ValidateStartupEvidence(root, allowPendingIdentityRecovery: true);
        await Journal.InitializeAsync();
        await EnsureIdentityStartupAsync();
        await agents.BootstrapMainMemoryAsync(AppContext.BaseDirectory);
        await LoadOwnersAsync(startMainServices: true);
    }
}
