using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Main's Session catalog: the queryable projection of every Session's authority and Main-owned
/// fields (name, parent, pins, archive state, last channel), identity aliases, and the topology,
/// presentation, group and activity queries over it. Projection follows authority publication;
/// the catalog never hydrates authority. The file implementation is <see cref="SessionCatalog"/>.
/// Pure value helpers stay static on <see cref="SessionCatalog"/>.
/// </summary>
internal interface ISessionCatalogStore : IDisposable
{
    /// <summary>Raised after any committed change to the projected rows.</summary>
    event Action? Changed;

    /// <summary>Called before a presentation mutation with the rows it will change.</summary>
    Func<JsonObject[], IDisposable>? BeforePresentationMutation { get; set; }

    /// <summary>Changes with every committed catalog write.</summary>
    string Revision { get; }

    /// <summary>Whether the catalog was ever created; false before the first initialization.</summary>
    bool Exists { get; }

    /// <summary>
    /// Opens an existing catalog for pending identity recovery without migrating it; throws when
    /// none exists.
    /// </summary>
    void OpenIdentityRecovery();

    /// <summary>Rows whose parent reference names <paramref name="id"/>, ordered by Session ID.</summary>
    JsonObject[] IdentityChildren(string id);

    void Initialize();
    JsonObject? Get(string id);
    JsonObject[] GetMany(IEnumerable<string> requested);
    JsonObject[] List(int limit = int.MaxValue, int offset = 0);
    JsonObject[] QuestionRows(int limit);
    JsonObject Resolve(string requested);
    JsonObject? Presentation(string id);
    string[] PathIds(string id);
    void PublishAuthority(JsonObject authority, bool allowInsert = false);
    void Rename(string id, string? name);
    bool RenameIfUnnamed(string id, string name);
    Dictionary<string, double> SubtreeTimes(string[] ids);
    Dictionary<string, int> RecentChildCounts(string[] parents, double since, int cap);
    string[] RestartIds();
    string[] PendingApprovalIds();
    string[] RecentWaitIds(long activityCutoff);
    long Count(string? agent = null, string? parent = null);
    JsonObject[] OffsetPage(
        int limit,
        int offset,
        string? agent = null,
        string? parent = null
    );
    CatalogPage Page(
        string mode,
        int limit,
        JsonArray? after,
        bool roots,
        string? agent,
        bool pinnedOnly = false
    );
    CatalogChildren[] Children(
        IReadOnlyList<(string Id, JsonArray? After)> requests,
        string mode,
        int limit,
        string? agent,
        IReadOnlyDictionary<string, int>? limits = null
    );
    Dictionary<string, long> ChildCounts(string[] ids, string? agent = null);
    Dictionary<string, JsonObject> Scopes(string[] ids);
    Dictionary<string, JsonObject> ResolveMany(string[] ids);
    Dictionary<string, string[]> Paths(string[] ids);
    JsonObject Summary();
    JsonObject Summary(out long costCount);
    Dictionary<string, (int Total, int Active, int Queued)> AgentActivityCounts();
    JsonArray AgentCounts();
    (JsonObject Summary, JsonObject[] Rows, long CostCount) Descendants(
        string id,
        int limit
    );
    HashSet<string> FilterDescendants(string id, string[] candidates);
    Dictionary<string, int> BusyDescendants(string[] roots, string[] busy);
    Dictionary<string, long> GroupCounts(string by, bool tree);
    CatalogPage GroupPage(
        string by,
        string key,
        string mode,
        int limit,
        JsonArray? after,
        string? exclude
    );
    Dictionary<string, string> GroupKeys(string[] ids, string by);
    IReadOnlyList<SessionCatalog.SequenceSession> SequenceSessions();
    PresentationChange SetLastChannel(string id, JsonObject channel);
    PresentationChange Archive(
        string requested,
        bool archived,
        bool descendants = false,
        bool singleCommand = false
    );
    PresentationChange Pin(string requested, bool pinned);
    PresentationChange SetParent(string requested, string? parent);
    PresentationChange Move(string requested, JsonObject body, bool promote = false);
    string[] RewriteIdentity(
        string from,
        string to,
        string agent,
        string[] aliases,
        bool requireSource = true
    );
    string ValidateIdentityParent(string child, string parent);
    void NotifyIdentityChanged();
    DeleteSelection SelectDeletion(string requested, bool recursive);
    void RemoveForDeletion(string id);

    // ---- Async paths ----------------------------------------------------------------------
    // A store whose writes hold a gate around synchronous database I/O overrides these, so
    // callers on async paths wait for it without blocking a pool thread (hosted-database.md).
    // The defaults run the synchronous member.

    Task PublishAuthorityAsync(JsonObject authority, bool allowInsert = false) =>
        Completed(() =>
        {
            PublishAuthority(authority, allowInsert);
            return true;
        });

    Task<PresentationChange> SetLastChannelAsync(string id, JsonObject channel) =>
        Completed(() => SetLastChannel(id, channel));

    Task<PresentationChange> ArchiveAsync(
        string requested,
        bool archived,
        bool descendants = false,
        bool singleCommand = false
    ) => Completed(() => Archive(requested, archived, descendants, singleCommand));

    Task<PresentationChange> PinAsync(string requested, bool pinned) =>
        Completed(() => Pin(requested, pinned));

    Task<PresentationChange> SetParentAsync(string requested, string? parent) =>
        Completed(() => SetParent(requested, parent));

    Task<PresentationChange> MoveAsync(string requested, JsonObject body, bool promote = false) =>
        Completed(() => Move(requested, body, promote));

    /// <summary>
    /// Runs read queries on this catalog. A gated store holds its gate for the body, waiting for
    /// it without a thread, and the members the body calls join that hold.
    /// </summary>
    Task<T> QueryAsync<T>(Func<T> body) => Completed(body);

    private static Task<T> Completed<T>(Func<T> body)
    {
        try
        {
            return Task.FromResult(body());
        }
        catch (Exception error)
        {
            return Task.FromException<T>(error);
        }
    }
}
