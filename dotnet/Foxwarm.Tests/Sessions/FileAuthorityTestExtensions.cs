using Foxwarm.Sessions;

namespace Foxwarm.Tests;

/// <summary>File-mode views of a bound Session authority store for tests.</summary>
internal static class FileAuthorityTestExtensions
{
    internal static string AuthorityPath(this ISessionAuthority store) =>
        ((PersistentSessionAuthorityStore)store).AuthorityPath;

    /// <summary>The SQLite Archive view, for file-mode Vector checkpoint inspection.</summary>
    internal static SqliteArchiveMessageStore Sqlite(this IArchiveSession archive) =>
        (SqliteArchiveMessageStore)archive;

    /// <summary>The SQLite catalog, for file-mode fixtures, query observation and test hooks.</summary>
    internal static SessionCatalog File(this ISessionCatalogStore catalog) => (SessionCatalog)catalog;

    /// <summary>The SQLite journal, for writer hooks and migration markers.</summary>
    internal static Foxwarm.Models.LlmRequestJournalStore File(
        this Foxwarm.Models.ILlmJournalStore journal
    ) => (Foxwarm.Models.LlmRequestJournalStore)journal;

    /// <summary>The file holding an image blob; throws for an invalid blob ID.</summary>
    internal static string BlobFile(this Foxwarm.Images.ImageBlobStore images, string id) =>
        images.LocalPath(id)!;

    /// <summary>The image blob directory.</summary>
    internal static string BlobRoot(this Foxwarm.Images.ImageBlobStore images) =>
        ((Foxwarm.Images.ImageBlobFiles)images.Blobs).Root;

    /// <summary>The run-record files, for write-stage hooks.</summary>
    internal static Foxwarm.ToolScript.ToolScriptRunStore File(
        this Foxwarm.ToolScript.IToolScriptRunStore store
    ) => (Foxwarm.ToolScript.ToolScriptRunStore)store;
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
