using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// <see cref="ISessionCatalogStore"/> in the tenant's catalog tables (migration 0200). Rows,
/// aliases, the maintained counts and subtree activity follow the file catalog's schema
/// version 3: the counts and activity are kept by PL/pgSQL triggers, and the queries are the
/// SQLite ones with byte-ordered text and the same keyset order. The presentation, deletion
/// and identity rules are <see cref="SessionCatalogRules"/>, shared with the file catalog.
/// </summary>
/// <remarks>
/// <para>
/// Writes serialize. An asynchronous catalog query has its own read-only snapshot, including
/// nested catalog and archive reads. Readers wait for the tenant's statement cap, not for the
/// writer. Ordinary point lookups can also join another store's tenant transaction.
/// </para>
/// <para>
/// Every write is one fenced <see cref="TenantDb"/> transaction that also raises the tenant's
/// <c>catalog_revision</c> exactly when the file catalog raises its revision; a lost
/// <c>COMMIT</c> is resolved by that counter. <see cref="Revision"/> is this instance's
/// identity plus the counter, so cursors of an earlier process never apply. Changed events
/// stay in-process: the tenant has a single owner. Migration from earlier catalog layouts is
/// file-only.
/// </para>
/// <para>
/// PostgreSQL text can't hold NUL. A lookup key containing one names no row, which is what
/// SQLite answers for it.
/// </para>
/// </remarks>
internal sealed partial class PgSessionCatalog(TenantDb database)
    : ISessionCatalogStore,
        ICatalogRowView
{
    private const string Columns = "metadata_json,busy,queue_length,managed_pending_count";

    private static readonly string[] Fields =
    [
        "session_id",
        "agent",
        "parent_reference",
        "parent_session_id",
        "display_name",
        "archived",
        "pinned",
        "sidebar_order",
        "last_message_time",
        "message_count",
        "busy",
        "queue_length",
        "managed_pending_count",
        "current_node",
        "cwd",
        "vector_index_position",
        "cached_tokens",
        "input_tokens",
        "output_tokens",
        "cost",
        "metadata_json",
        "question_open",
        "question_approvals",
        "wait_present",
    ];

    private static readonly string UpsertSql =
        $"INSERT INTO session_catalog({string.Join(',', Fields)}) VALUES({string.Join(',', Fields.Select((_, index) => "$" + (index + 1)))})"
        + " ON CONFLICT (tenant_id, session_id) DO UPDATE SET "
        + string.Join(',', Fields.Skip(1).Select(field => field + "=excluded." + field));

    // Holders run synchronous Npgsql I/O: async paths wait with HoldAsync (hosted-database.md).
    private readonly Foxwarm.Storage.StoreGate gate = new();
    private readonly string instance = Guid.NewGuid().ToString("N");

    // The transaction of the synchronous gate holder or writer.
    private PgTx? current;

    // A QueryAsync callback is synchronous; each worker can run its own read snapshot.
    // Do not flow this slot to child Tasks or share its connection across catalog instances.
    [ThreadStatic]
    private static (PgSessionCatalog? Store, PgTx? Transaction) query;
    private PgTx? QueryTransaction => ReferenceEquals(query.Store, this) ? query.Transaction : null;
    private IDisposable? ReadGate() => QueryTransaction is null ? gate.Enter() : null;
    private long revision;
    private volatile bool initialized;

    public event Action? Changed;

    public Func<JsonObject[], IDisposable>? BeforePresentationMutation { get; set; }

    // Read without the gate once initialized: only a gate holder writes it.
    public string Revision
    {
        get
        {
            if (QueryTransaction is { } snapshot)
                return instance + ":" + (snapshot.Scalar("SELECT revision FROM catalog_revision") as long? ?? 0);
            if (!initialized)
                using (gate.Enter())
                    EnsureInitialized();
            return instance + ":" + Interlocked.Read(ref revision);
        }
    }

    /// <summary>The schema exists from the first migration, so the catalog always does.</summary>
    public bool Exists => true;

    public void OpenIdentityRecovery() { }

    public void Initialize()
    {
        using (gate.Enter())
            EnsureInitialized();
    }

    private void EnsureInitialized()
    {
        if (initialized)
            return;
        revision = Read(tx => tx.Scalar("SELECT revision FROM catalog_revision") as long? ?? 0);
        initialized = true;
    }

    // ---- Transactions -------------------------------------------------------------------

    // Caller holds the gate. Nested calls share the running transaction.
    private T Read<T>(Func<PgTx, T> body)
    {
        if ((QueryTransaction ?? current) is { } running)
            return body(running);
        return database.Read(tx => WithCurrent(tx, () => body(tx)));
    }

    // Exact reads without the gate get their own transaction, or join the transaction another
    // store's body runs in on this database (the Task store canonicalizing references); the
    // gate holder's join its own.
    private T Exact<T>(Func<PgTx, T> body) =>
        QueryTransaction is { } snapshot ? body(snapshot) : database.ReadOrJoin(body);

    // Caller holds the gate and runs no transaction. `raise` decides from the body's result
    // whether this write raises the revision; without it every write does.
    private T Write<T>(Func<PgTx, T> body, Func<T, bool>? raise = null)
    {
        var write = new CatalogWrite<T>(this, body, raise);
        return write.Finish(database.Write(write.Run, write.Options));
    }

    private Task<T> WriteAsync<T>(Func<PgTx, T> body, Func<T, bool>? raise = null) =>
        gate.HoldAsync(async () =>
        {
            var write = new CatalogWrite<T>(this, body, raise);
            return write.Finish(await database.WriteAsync(write.Run, write.Options).ConfigureAwait(false));
        });

    // The catalog revision and the data commit together. Verification runs after this
    // transaction has given back its connection and statement slot.
    private sealed class CatalogWrite<T>(PgSessionCatalog catalog, Func<PgTx, T> body, Func<T, bool>? raise)
    {
        private long written;

        internal PgWriteOptions Options => new(Verify: tx =>
            written == 0 || tx.Scalar("SELECT revision FROM catalog_revision") as long? == written);

        internal T Run(PgTx tx) => catalog.WithCurrent(tx, () =>
        {
            catalog.EnsureInitialized();
            var result = body(tx);
            written = raise is null || raise(result)
                ? (long)tx.Scalar(
                    "INSERT INTO catalog_revision AS r (revision) VALUES (1)"
                    + " ON CONFLICT (tenant_id) DO UPDATE SET revision = r.revision + 1 RETURNING revision"
                )!
                : 0;
            catalog.BeforeCommit?.Invoke();
            return result;
        });

        internal T Finish(T result)
        {
            if (written != 0)
                Interlocked.Exchange(ref catalog.revision, written);
            return result;
        }
    }

    private T WithCurrent<T>(PgTx tx, Func<T> body)
    {
        current = tx;
        try
        {
            return gate.InBody(body);
        }
        finally
        {
            current = null;
        }
    }

    private PgTx Current => QueryTransaction ?? current ?? throw new InvalidOperationException("No catalog transaction.");

    // ---- Reading ------------------------------------------------------------------------

    private static bool Storable(string? text) => text is null || !text.Contains('\0');

    private static string[] StorableIds(IEnumerable<string> ids) => ids.Where(Storable).ToArray();

    // A text[] parameter; a bare string[] argument would bind as one parameter per element.
    private static NpgsqlParameter TextArray(string[] values) =>
        new NpgsqlParameter<string[]> { TypedValue = values };

    private static JsonObject ReadRow(NpgsqlDataReader reader, int offset = 0)
    {
        var row = JsonNode.Parse(reader.GetString(offset))!.AsObject();
        row["busy"] = reader.GetInt64(offset + 1) == 1;
        row["queueLength"] = reader.GetInt64(offset + 2);
        row["managedPendingCount"] = reader.GetInt64(offset + 3);
        return row;
    }

    private List<JsonObject> Rows(PgTx tx, string sql, params object?[] args)
    {
        using var command = Command(tx, sql, args);
        using var reader = command.ExecuteReader();
        var rows = new List<JsonObject>();
        while (reader.Read())
            rows.Add(ReadRow(reader));
        return rows;
    }

    private List<string> Strings(PgTx tx, string sql, params object?[] args)
    {
        using var command = Command(tx, sql, args);
        using var reader = command.ExecuteReader();
        var values = new List<string>();
        while (reader.Read())
            values.Add(reader.GetString(0));
        return values;
    }

    /// <summary>Test hook at the end of each write transaction, right before its COMMIT.</summary>
    internal Action? BeforeCommit { get; set; }

    /// <summary>Test observation of each query statement and its arguments, before it runs.</summary>
    internal Action<string, object?[]>? StatementObserved { get; set; }

    private NpgsqlCommand Command(PgTx tx, string sql, params object?[] args)
    {
        StatementObserved?.Invoke(sql, args);
        return tx.Command(sql, args);
    }

    private static string? Text(JsonNode? node) => SessionCatalog.Text(node);

    private static long Long(object value) => Convert.ToInt64(value);

    public JsonObject? Get(string id) =>
        Storable(id)
            ? Exact(tx =>
                Rows(tx, $"SELECT {Columns} FROM session_catalog WHERE session_id=$1", id)
                    .FirstOrDefault()
            )
            : null;

    public JsonObject[] GetMany(IEnumerable<string> requested)
    {
        var ids = requested.Distinct(StringComparer.Ordinal).ToArray();
        if (ids.Length > 200)
            throw new InvalidDataException("Catalog exact batch exceeds 200 IDs.");
        var storable = StorableIds(ids);
        if (storable.Length == 0)
            return [];
        using (ReadGate())
        {
            var rows = Read(tx =>
                Rows(
                    tx,
                    $"SELECT {Columns} FROM session_catalog WHERE session_id = ANY($1)",
                    TextArray(storable)
                )
            );
            var byId = rows.ToDictionary(row => Text(row["id"])!, StringComparer.Ordinal);
            return ids.Where(byId.ContainsKey).Select(id => byId[id]).ToArray();
        }
    }

    public JsonObject[] List(int limit = int.MaxValue, int offset = 0)
    {
        using (ReadGate())
            return Read(tx =>
                    Rows(
                        tx,
                        $"SELECT {Columns} FROM session_catalog ORDER BY recent_rank,session_id LIMIT $1 OFFSET $2",
                        (long)limit,
                        (long)offset
                    )
                )
                .ToArray();
    }

    public JsonObject[] QuestionRows(int limit)
    {
        using (ReadGate())
            return Read(tx =>
                    Rows(
                        tx,
                        $"SELECT {Columns} FROM session_catalog WHERE question_open>0 ORDER BY recent_rank,session_id LIMIT $1",
                        (long)limit
                    )
                )
                .ToArray();
    }

    public JsonObject Resolve(string requested)
    {
        if (!Storable(requested))
            return new JsonObject { ["kind"] = "missing" };
        // One statement gives exact precedence and alias ambiguity one snapshot.
        var owners = Exact(tx =>
        {
            using var command = Command(tx, 
                "SELECT session_id,1 AS exact FROM session_catalog WHERE session_id=$1 "
                    + "UNION ALL SELECT session_id,0 FROM session_alias WHERE alias=$1 "
                    + "AND NOT EXISTS(SELECT 1 FROM session_catalog WHERE session_id=$1) "
                    + "ORDER BY exact DESC,session_id LIMIT 2",
                requested
            );
            using var reader = command.ExecuteReader();
            var found = new List<(string Id, bool Exact)>();
            while (reader.Read())
                found.Add((reader.GetString(0), reader.GetInt32(1) == 1));
            return found;
        });
        if (owners.Count == 0)
            return new JsonObject { ["kind"] = "missing" };
        if (owners[0].Exact)
            return new JsonObject { ["kind"] = "exact", ["sessionId"] = owners[0].Id };
        return owners.Count > 1
            ? new JsonObject
            {
                ["kind"] = "ambiguous",
                ["sessionIds"] = new JsonArray(owners[0].Id, owners[1].Id),
            }
            : new JsonObject { ["kind"] = "alias", ["sessionId"] = owners[0].Id };
    }

    private string? ParentOf(string id) =>
        Current.Scalar("SELECT parent_session_id FROM session_catalog WHERE session_id=$1", id)
            as string;

    public JsonObject? Presentation(string id)
    {
        if (!Storable(id))
            return null;
        using (ReadGate())
            return Read(_ =>
            {
                var row = Get(id);
                if (row is null)
                    return null;
                row["parentSessionId"] = ParentOf(id);
                return row;
            });
    }

    public string[] PathIds(string id)
    {
        if (!Storable(id))
            return [];
        using (ReadGate())
            return Read(_ =>
            {
                var result = new List<string>();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                while (seen.Add(id) && Get(id) is not null)
                {
                    result.Add(id);
                    if (ParentOf(id) is not string parent)
                        break;
                    id = parent;
                }
                result.Reverse();
                return result.ToArray();
            });
    }

    public JsonObject[] IdentityChildren(string id)
    {
        if (!Storable(id))
            return [];
        using (ReadGate())
            return Read(tx =>
                    Rows(
                        tx,
                        $"SELECT {Columns} FROM session_catalog WHERE parent_reference=$1 ORDER BY session_id",
                        id
                    )
                )
                .ToArray();
    }

    IReadOnlyList<(JsonObject Row, string? Parent)> ICatalogRowView.ResolvedRows()
    {
        // The parent reference resolves as Resolve does: the exact Session, else a unique alias.
        using var command = Command(Current, 
            $"SELECT {Columns},CASE WHEN s.parent_reference IS NULL OR s.parent_reference='' THEN NULL "
                + "WHEN EXISTS(SELECT 1 FROM session_catalog e WHERE e.session_id=s.parent_reference) THEN s.parent_reference "
                + "ELSE (SELECT CASE WHEN count(*)=1 THEN min(a.session_id) END FROM "
                + "(SELECT session_id FROM session_alias WHERE alias=s.parent_reference ORDER BY session_id LIMIT 2) a) END "
                + "FROM session_catalog s ORDER BY s.session_id"
        );
        using var reader = command.ExecuteReader();
        var rows = new List<(JsonObject, string?)>();
        while (reader.Read())
            rows.Add((ReadRow(reader), reader.IsDBNull(4) ? null : reader.GetString(4)));
        return rows;
    }

    IReadOnlyList<JsonObject> ICatalogRowView.SiblingRows(string? parent, string exclude) =>
        Storable(parent)
            ? Rows(
                Current,
                $"SELECT {Columns} FROM session_catalog WHERE NULLIF(btrim(parent_reference,$1),'') IS NOT DISTINCT FROM $2 AND session_id<>$3 ORDER BY session_id",
                SessionCatalogRules.Spaces,
                parent,
                exclude
            )
            : [];

    // ---- Writing ------------------------------------------------------------------------

    // A SQLite STRICT INTEGER column takes only integral values; so does this one.
    private static long? Integer(double? value) =>
        value switch
        {
            null => null,
            { } number when number == Math.Floor(number) && number >= long.MinValue && number < 9.2233720368547758E+18 =>
                (long)number,
            _ => throw new InvalidDataException("Session catalog integer field is not an integer."),
        };

    private static object? Value(long? value) => value is { } number ? number : null;

    private static object? Value(double? value) => value is { } number ? number : null;

    private void Insert(PgTx tx, JsonObject row)
    {
        var id = Text(row["id"])!;
        var meta = row["meta"] as JsonObject;
        var questions = meta?["questions"] as JsonObject;
        var waitId = (meta?["wait"] as JsonObject)?["id"];
        var values = new object?[]
        {
            id,
            Text(row["agent"]),
            Text(row["parentSessionId"]),
            Text(row["parentSessionId"]),
            Text(row["displayName"]),
            SessionCatalog.Flag(row["archived"]) ? 1L : 0L,
            SessionCatalog.Flag(row["pinned"]) ? 1L : 0L,
            Value(SessionCatalog.Number(row["sidebarOrder"])),
            SessionCatalog.Number(meta?["lastMessageTime"]) ?? 0,
            Integer(SessionCatalog.Number(meta?["messageCount"]) ?? 0),
            SessionCatalog.Flag(row["busy"]) ? 1L : 0L,
            Integer(SessionCatalog.Number(row["queueLength"]) ?? 0),
            Integer(SessionCatalog.Number(row["managedPendingCount"]) ?? 0),
            Text(row["currentNode"]),
            Text(row["cwd"]),
            Value(Integer(SessionCatalog.Number(row["vectorIndexPosition"]))),
            Integer(SessionCatalog.Number(row["stats"]?["totalCachedTokens"]) ?? 0),
            Integer(SessionCatalog.Number(row["stats"]?["totalInputTokens"]) ?? 0),
            Integer(SessionCatalog.Number(row["stats"]?["totalOutputTokens"]) ?? 0),
            Value(SessionCatalog.Number(row["stats"]?["totalCost"])),
            row.ToJsonText(),
            Value(SessionCatalog.Number(questions?["open"])),
            Value(SessionCatalog.Number(questions?["approvals"])),
            waitId is JsonValue wait && wait.GetValueKind() == JsonValueKind.String,
        };
        tx.Execute(UpsertSql, values);
        tx.Execute("DELETE FROM session_alias WHERE session_id=$1", id);
        var aliases = row["aliases"]!.AsArray().Select(alias => Text(alias)!).ToArray();
        if (aliases.Length > 0)
            tx.Execute(
                "INSERT INTO session_alias(alias,session_id,ordinal) "
                    + "SELECT alias,$2,ordinal-1 FROM unnest($1::text[]) WITH ORDINALITY AS a(alias,ordinal)",
                TextArray(aliases),
                id
            );
    }

    private void WriteRows(PgTx tx, JsonObject[] records)
    {
        var references = new HashSet<string>(StringComparer.Ordinal);
        foreach (var row in records)
        {
            var id = Text(row["id"])!;
            references.Add(id);
            if (Text(row["parentSessionId"]) is { } parentReference)
                references.Add(parentReference);
            references.UnionWith(
                Strings(tx, "SELECT alias FROM session_alias WHERE session_id=$1", id)
            );
            Insert(tx, row);
            foreach (var alias in row["aliases"]!.AsArray())
                references.Add(Text(alias)!);
        }
        NormalizeParents(tx, references);
    }

    // Re-resolves the canonical parent of every row whose raw reference is one of
    // `references`: the exact Session, else a unique alias owner, never the row itself.
    private void NormalizeParents(PgTx tx, HashSet<string> references)
    {
        var storable = StorableIds(references);
        if (storable.Length == 0)
            return;
        var changes = new List<(string Id, string? Parent)>();
        using (
            var command = Command(tx, 
                "SELECT s.session_id,s.parent_session_id,CASE WHEN s.parent_reference='' THEN NULL "
                    + "WHEN EXISTS(SELECT 1 FROM session_catalog e WHERE e.session_id=s.parent_reference) THEN s.parent_reference "
                    + "ELSE (SELECT CASE WHEN count(*)=1 THEN min(a.session_id) END FROM "
                    + "(SELECT session_id FROM session_alias WHERE alias=s.parent_reference ORDER BY session_id LIMIT 2) a) END "
                    + "FROM session_catalog s WHERE s.parent_reference = ANY($1) ORDER BY s.session_id",
                TextArray(storable)
            )
        )
        using (var reader = command.ExecuteReader())
            while (reader.Read())
            {
                var id = reader.GetString(0);
                var written = reader.IsDBNull(1) ? null : reader.GetString(1);
                var canonical = reader.IsDBNull(2) ? null : reader.GetString(2);
                if (canonical == id)
                    canonical = null;
                if (!string.Equals(canonical, written, StringComparison.Ordinal))
                    changes.Add((id, canonical));
            }
        foreach (var (id, parent) in changes)
            tx.Execute(
                "UPDATE session_catalog SET parent_session_id=$1 WHERE session_id=$2",
                parent,
                id
            );
    }

    /// <summary>Writes projected copies of raw rows as they are (test seeding, like the file catalog's).</summary>
    internal void Upsert(IEnumerable<JsonObject> input) =>
        Import(input.Select(SessionCatalog.Project).ToArray());

    /// <summary>
    /// Writes rows that already are catalog projections, unchanged: rows read from another
    /// catalog keep fields an earlier projection wrote (golden comparison).
    /// </summary>
    internal void Import(JsonObject[] records)
    {
        using (gate.Enter())
            Write(tx =>
            {
                WriteRows(tx, records);
                return true;
            });
        Changed?.Invoke();
    }

    public void PublishAuthority(JsonObject authority, bool allowInsert = false)
    {
        using (gate.Enter())
            Write(tx => WriteAuthority(tx, authority, allowInsert));
        Changed?.Invoke();
    }

    public async Task PublishAuthorityAsync(JsonObject authority, bool allowInsert = false)
    {
        await WriteAsync(tx => WriteAuthority(tx, authority, allowInsert)).ConfigureAwait(false);
        Changed?.Invoke();
    }

    // Caller holds the gate.
    private bool WriteAuthority(PgTx tx, JsonObject authority, bool allowInsert)
    {
        if (Get(Text(authority["id"])!) is { } main)
            SessionCatalog.OverlayMain(authority, main);
        else if (!allowInsert)
            throw new InvalidOperationException("Session catalog membership is no longer current.");
        WriteRows(tx, [SessionCatalog.Project(authority)]);
        return true;
    }

    public void Rename(string id, string? name)
    {
        using (gate.Enter())
            Write(tx =>
            {
                var row = Get(id) ?? throw new InvalidDataException("Session not found.");
                if (name is null)
                    row.Remove("displayName");
                else
                    row["displayName"] = name;
                WriteRows(tx, [row]);
                return true;
            });
        Changed?.Invoke();
    }

    // Sets a label only while none is present; the check and write share one transaction.
    public bool RenameIfUnnamed(string id, string name)
    {
        bool renamed;
        using (gate.Enter())
            renamed = Write(
                tx =>
                {
                    var row = Get(id);
                    if (row is null || !string.IsNullOrEmpty(Text(row["displayName"])))
                        return false;
                    row["displayName"] = name;
                    WriteRows(tx, [row]);
                    return true;
                },
                raise: written => written
            );
        if (!renamed)
            return false;
        Changed?.Invoke();
        return true;
    }

    public string[] RewriteIdentity(
        string from,
        string to,
        string agent,
        string[] aliases,
        bool requireSource = true
    )
    {
        using (gate.Enter())
            return Write(tx =>
            {
                var rewrite = SessionCatalogRules.RewriteIdentity(
                    this,
                    from,
                    to,
                    agent,
                    aliases,
                    requireSource
                );
                if (rewrite.HasSource)
                    tx.Execute("DELETE FROM session_catalog WHERE session_id=$1", from);
                WriteRows(tx, rewrite.Rows);
                NormalizeParents(
                    tx,
                    new HashSet<string>(aliases, StringComparer.Ordinal) { from, to }
                );
                return rewrite.Direct;
            });
    }

    public string ValidateIdentityParent(string child, string parent)
    {
        using (ReadGate())
            return Read(_ =>
            {
                var id = Text(
                    SessionCatalogRules.RequiredMain(this, parent, "parentSessionId")["id"]
                )!;
                SessionCatalogRules.ValidateParent(this, child, id);
                return id;
            });
    }

    public void NotifyIdentityChanged() => Changed?.Invoke();

    public DeleteSelection SelectDeletion(string requested, bool recursive)
    {
        using (ReadGate())
            return Read(_ => SessionCatalogRules.SelectDeletion(this, requested, recursive));
    }

    public void RemoveForDeletion(string id)
    {
        using (gate.Enter())
            Write(tx =>
            {
                var old =
                    Get(id)
                    ?? throw new InvalidDataException(
                        "Deletion membership disappeared before its catalog commit."
                    );
                var references = new HashSet<string>(StringComparer.Ordinal) { id };
                foreach (var alias in old["aliases"]?.AsArray() ?? [])
                    if (Text(alias) is { } text)
                        references.Add(text);
                tx.Execute("DELETE FROM session_catalog WHERE session_id=$1", id);
                NormalizeParents(tx, references);
                return true;
            });
        Changed?.Invoke();
    }

    // ---- Presentation -------------------------------------------------------------------

    private PresentationChange CommitPresentation(
        Func<(JsonObject Result, JsonObject[] Rows)> prepare
    )
    {
        PresentationChange result;
        using (gate.Enter())
            result = Write(tx => ApplyPresentation(tx, prepare), HasChanges);
        return Presented(result);
    }

    private async Task<PresentationChange> CommitPresentationAsync(
        Func<(JsonObject Result, JsonObject[] Rows)> prepare
    ) => Presented(await WriteAsync(tx => ApplyPresentation(tx, prepare), HasChanges).ConfigureAwait(false));

    private static bool HasChanges(PresentationChange change) => change.ChangedIds.Length > 0;

    private PresentationChange ApplyPresentation(PgTx tx, Func<(JsonObject Result, JsonObject[] Rows)> prepare)
    {
        var operation = prepare();
        using var admission = BeforePresentationMutation?.Invoke(operation.Rows);
        WriteRows(tx, operation.Rows);
        return new(operation.Result, operation.Rows.Select(row => Text(row["id"])!).ToArray());
    }

    // After the gate's release: a committed change is announced.
    private PresentationChange Presented(PresentationChange result)
    {
        if (result.ChangedIds.Length > 0)
            try
            {
                Changed?.Invoke();
            }
            catch (Exception error)
            {
                throw new PresentationCommittedException(result, error);
            }
        return result;
    }

    public PresentationChange SetLastChannel(string id, JsonObject channel) =>
        CommitPresentation(() => SessionCatalogRules.SetLastChannel(this, id, channel));

    public PresentationChange Archive(
        string requested,
        bool archived,
        bool descendants = false,
        bool singleCommand = false
    ) =>
        CommitPresentation(() =>
            SessionCatalogRules.Archive(this, requested, archived, descendants, singleCommand)
        );

    public PresentationChange Pin(string requested, bool pinned) =>
        CommitPresentation(() => SessionCatalogRules.Pin(this, requested, pinned));

    public PresentationChange SetParent(string requested, string? parent) =>
        CommitPresentation(() => SessionCatalogRules.SetParent(this, requested, parent));

    public PresentationChange Move(string requested, JsonObject body, bool promote = false) =>
        CommitPresentation(() => SessionCatalogRules.Move(this, requested, body, promote));

    public Task<PresentationChange> SetLastChannelAsync(string id, JsonObject channel) =>
        CommitPresentationAsync(() => SessionCatalogRules.SetLastChannel(this, id, channel));

    public Task<PresentationChange> ArchiveAsync(
        string requested,
        bool archived,
        bool descendants = false,
        bool singleCommand = false
    ) =>
        CommitPresentationAsync(() =>
            SessionCatalogRules.Archive(this, requested, archived, descendants, singleCommand)
        );

    public Task<PresentationChange> PinAsync(string requested, bool pinned) =>
        CommitPresentationAsync(() => SessionCatalogRules.Pin(this, requested, pinned));

    public Task<PresentationChange> SetParentAsync(string requested, string? parent) =>
        CommitPresentationAsync(() => SessionCatalogRules.SetParent(this, requested, parent));

    public Task<PresentationChange> MoveAsync(string requested, JsonObject body, bool promote = false) =>
        CommitPresentationAsync(() => SessionCatalogRules.Move(this, requested, body, promote));

    /// <summary>
    /// Runs read queries on this catalog holding its gate, waiting for it without a thread; the
    /// members the body calls join the hold.
    /// </summary>
    public Task<T> QueryAsync<T>(Func<T> body) =>
        database.ReadAsync(tx =>
        {
            var previous = query;
            query = (this, tx);
            try { return body(); }
            finally { query = previous; }
        }, snapshot: true);

    public IReadOnlyList<SessionCatalog.SequenceSession> SequenceSessions() =>
        database.Read(tx =>
        {
            using var command = Command(tx, 
                "SELECT session_id,parent_session_id,last_message_time,busy,message_count FROM session_catalog ORDER BY session_id"
            );
            using var reader = command.ExecuteReader();
            var rows = new List<SessionCatalog.SequenceSession>();
            while (reader.Read())
                rows.Add(
                    new(
                        reader.GetString(0),
                        reader.IsDBNull(1) ? null : reader.GetString(1),
                        reader.GetDouble(2),
                        reader.GetInt64(3) == 1,
                        reader.GetInt64(4)
                    )
                );
            return (IReadOnlyList<SessionCatalog.SequenceSession>)rows;
        });

    public void Dispose() { }
}
