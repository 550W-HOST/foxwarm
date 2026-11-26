using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Hosted;

/// <summary>
/// One tenant's stores in PostgreSQL, all writing through one <see cref="TenantDb"/> at the
/// replica's lease epoch. Each store is built by its own partial file
/// (<c>PostgresStorageContext.&lt;Store&gt;.cs</c>, owned by that store's track) implementing the
/// matching <c>Create…</c> partial method; a store without one stays missing, and hosted
/// startup refuses a context with missing stores (<see cref="Missing"/>).
/// The context owns what its stores started or opened (the journal's writer loop, the S3
/// client), so a runtime that fails to build, or is retired, releases them by disposing it.
/// </summary>
internal sealed partial class PostgresStorageContext : IStorageContext, IAsyncDisposable
{
    private int disposed;
    // The S3 client shared by the S3 blob stores (images, artifacts, Agent files); null on the
    // PostgreSQL blob backend.
    private IDisposable? s3Client;

    private ISessionAuthorityBackend? authority;
    private IArchiveStore? archive;
    private IIdentityLedger? identities;
    private ISessionCatalogStore? catalog;
    private ITaskRowStore? tasks;
    private Foxwarm.Models.ILlmJournalStore? journal;
    private Foxwarm.ToolScript.IToolScriptRunStore? toolScriptRuns;
    private IStateDocuments? documents;
    private IInstanceCredentials? credentials;
    private IBlobStore? imageBlobs;
    private IBlobStore? artifactBlobs;
    private IAgentFileStore? agentFiles;

    internal PostgresStorageContext(TenantDb database, string scratchRoot)
    {
        Database = database;
        ScratchRoot = Path.GetFullPath(scratchRoot);
        CreateArchive(ref archive);
        CreateIdentities(ref identities);
        CreateCatalog(ref catalog);
        CreateTasks(ref tasks);
        CreateJournal(ref journal);
        CreateToolScriptRuns(ref toolScriptRuns);
        CreateDocuments(ref documents);
        CreateCredentials(ref credentials);
        CreateImageBlobs(ref imageBlobs);
        CreateArtifactBlobs(ref artifactBlobs);
        CreateAgentFiles(ref agentFiles);
        CreateAuthority(ref authority);
    }

    internal TenantDb Database { get; }

    /// <summary>
    /// Stops the journal (its writer loop and retention) and disposes the S3 client. The
    /// Session runtime disposes the journal too when it was built; disposing twice is harmless.
    /// The tenant database isn't closed here: the lease owns it.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0)
            return;
        try
        {
            if (journal is not null)
                await journal.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            s3Client?.Dispose();
        }
    }

    /// <summary>The replica's ephemeral local directory (never tenant state).</summary>
    internal string ScratchRoot { get; }

    /// <summary>Names of the stores this build has no PostgreSQL implementation for.</summary>
    internal IReadOnlyList<string> Missing =>
        new (string Name, object? Store)[]
        {
            (nameof(Authority), authority),
            (nameof(Archive), archive),
            (nameof(Identities), identities),
            (nameof(Catalog), catalog),
            (nameof(Tasks), tasks),
            (nameof(Journal), journal),
            (nameof(ToolScriptRuns), toolScriptRuns),
            (nameof(Documents), documents),
            (nameof(Credentials), credentials),
            (nameof(ImageBlobs), imageBlobs),
            (nameof(ArtifactBlobs), artifactBlobs),
            (nameof(AgentFiles), agentFiles),
        }
            .Where(item => item.Store is null)
            .Select(item => item.Name)
            .ToArray();

    public ISessionAuthorityBackend Authority => Require(authority);

    public IArchiveStore Archive => Require(archive);

    public IIdentityLedger Identities => Require(identities);

    public ISessionCatalogStore Catalog => Require(catalog);

    public ITaskRowStore Tasks => Require(tasks);

    public Foxwarm.Models.ILlmJournalStore Journal => Require(journal);

    public Foxwarm.ToolScript.IToolScriptRunStore ToolScriptRuns => Require(toolScriptRuns);

    public IStateDocuments Documents => Require(documents);

    public IInstanceCredentials Credentials => Require(credentials);

    public IBlobStore ImageBlobs => Require(imageBlobs);

    public IBlobStore ArtifactBlobs => Require(artifactBlobs);

    public IAgentFileStore AgentFiles => Require(agentFiles);

    // Store tracks implement these in PostgresStorageContext.<Store>.cs. The authority is built
    // last, so it can use the Archive and blob stores.
    partial void CreateAuthority(ref ISessionAuthorityBackend? store);

    partial void CreateArchive(ref IArchiveStore? store);

    partial void CreateIdentities(ref IIdentityLedger? store);

    partial void CreateCatalog(ref ISessionCatalogStore? store);

    partial void CreateTasks(ref ITaskRowStore? store);

    partial void CreateJournal(ref Foxwarm.Models.ILlmJournalStore? store);

    partial void CreateToolScriptRuns(ref Foxwarm.ToolScript.IToolScriptRunStore? store);

    partial void CreateDocuments(ref IStateDocuments? store);

    partial void CreateCredentials(ref IInstanceCredentials? store);

    partial void CreateImageBlobs(ref IBlobStore? store);

    partial void CreateArtifactBlobs(ref IBlobStore? store);

    partial void CreateAgentFiles(ref IAgentFileStore? store);

    private static T Require<T>(T? store, [System.Runtime.CompilerServices.CallerMemberName] string name = "")
        where T : class =>
        store
        ?? throw new NotSupportedException(
            $"This build has no PostgreSQL implementation of the {name} store."
        );
}
