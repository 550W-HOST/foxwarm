namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    // Only the immutable Archive reservation graph proves a historical artifact's lifetime.
    // Main's optional metadata aliases do not authorize adopting another execution.
    private string ResolveExecLifetime(string recorded)
    {
        if (Storage.Archive.ResolveCommittedIdentity(recorded) is not { } canonical)
            return recorded;
        if (canonical != recorded && Catalog.Get(recorded) is not null)
            throw new InvalidDataException(
                "Historical execution identity conflicts with an exact Main lifetime."
            );
        return canonical;
    }
}
