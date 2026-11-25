using Foxwarm.Sessions;

namespace Foxwarm.Tests;

/// <summary>File-mode views of a bound Session authority store for tests.</summary>
internal static class FileAuthorityTestExtensions
{
    internal static string AuthorityPath(this ISessionAuthority store) =>
        ((PersistentSessionAuthorityStore)store).AuthorityPath;
}

/// <summary>File-mode staging of identity-move crash states for tests.</summary>
internal static class IdentityJournalTestExtensions
{
    internal static string AuthorityPath(this SessionIdentityMoveJournal journal, string id) =>
        Path.Combine(Path.GetDirectoryName(journal.FilePath)!, "sessions", id + ".json");

    /// <summary>The artifact moves of an identity move, including the file authority.</summary>
    internal static void MoveArtifacts(
        this SessionIdentityMoveJournal journal,
        string from,
        string to,
        int version = 2
    ) =>
        journal.MoveArtifacts(
            from,
            to,
            version,
            (source, target) => journal.MoveArtifact("state/sessions", ".json", source, target)
        );
}
