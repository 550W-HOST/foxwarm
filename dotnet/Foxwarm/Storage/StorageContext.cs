using Foxwarm.Sessions;

namespace Foxwarm.Storage;

/// <summary>
/// One runtime's persistent state. It is built once, at the host entry or by a test, and domain
/// code receives its stores instead of data-root paths. File mode keeps today's files under one
/// data directory (<see cref="FileStorageContext"/>).
/// </summary>
internal interface IStorageContext
{
    ISessionAuthorityBackend Authority { get; }
    IArchiveStore Archive { get; }
    IIdentityLedger Identities { get; }
    ISessionCatalogStore Catalog { get; }
    ITaskRowStore Tasks { get; }
    Foxwarm.Models.ILlmJournalStore Journal { get; }
    Foxwarm.ToolScript.IToolScriptRunStore ToolScriptRuns { get; }
    IStateDocuments Documents { get; }
    IInstanceCredentials Credentials { get; }

    /// <summary>Content-addressed image originals.</summary>
    IBlobStore ImageBlobs { get; }

    /// <summary>Artifact revisions and their resources.</summary>
    IBlobStore ArtifactBlobs { get; }
}

/// <summary>Construction seams of the file stores, used only by tests.</summary>
internal sealed record FileStorageOptions(
    Action<string, AtomicJsonWriteStage>? AuthorityStageHook = null,
    Func<string, int, CancellationToken, Task>? CanonicalCommitBarrier = null
);

/// <summary>Today's file and SQLite stores under one data directory.</summary>
internal sealed class FileStorageContext : IStorageContext
{
    internal FileStorageContext(string dataRoot, FileStorageOptions? options = null)
    {
        DataRoot = Path.GetFullPath(dataRoot);
        Archive = new SqliteArchiveStore(DataRoot);
        Identities = new FileIdentityLedger(DataRoot);
        Catalog = new SessionCatalog(DataRoot);
        Tasks = new SqliteTaskRowStore(DataRoot);
        Journal = new Foxwarm.Models.LlmRequestJournalStore(DataRoot);
        ToolScriptRuns = new Foxwarm.ToolScript.ToolScriptRunStore(DataRoot);
        Documents = new FileStateDocuments(DataRoot);
        Credentials = new FileInstanceCredentials(DataRoot);
        ImageBlobs = new Foxwarm.Images.ImageBlobFiles(DataRoot);
        ArtifactBlobs = new Foxwarm.Artifacts.ArtifactBlobFiles(
            Path.Combine(DataRoot, "state", "artifacts")
        );
        Authority = new FileSessionAuthorityBackend(
            DataRoot,
            options?.AuthorityStageHook,
            options?.CanonicalCommitBarrier,
            ImageBlobs
        );
    }

    internal string DataRoot { get; }

    public ISessionAuthorityBackend Authority { get; }

    public IArchiveStore Archive { get; }

    public IIdentityLedger Identities { get; }

    public ISessionCatalogStore Catalog { get; }

    public ITaskRowStore Tasks { get; }

    public Foxwarm.Models.ILlmJournalStore Journal { get; }

    public Foxwarm.ToolScript.IToolScriptRunStore ToolScriptRuns { get; }

    public IStateDocuments Documents { get; }

    public IInstanceCredentials Credentials { get; }

    public IBlobStore ImageBlobs { get; }

    public IBlobStore ArtifactBlobs { get; }
}
