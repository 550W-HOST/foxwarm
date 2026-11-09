using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>
/// Installation-wide usage from the journal's derived ledger: the background ledger backfill
/// and grouped period queries for System › Usage and the status bar. Spend is attributed when
/// read, to the Agent that currently owns each Session, so it follows a Session that moves.
/// Read-only presentation; it never changes Session accounting or prices.
/// </summary>
internal sealed class UsageOverview : IAsyncDisposable
{
    internal static readonly string[] Groupings =
    [
        "agent",
        "tree",
        "session",
        "model",
        "provider",
        "purpose",
    ];

    internal const int MaxBuckets = 400;
    internal const int MaxGroups = 500;
    internal const int SeriesGroups = 8;

    private readonly SessionManager manager;
    private readonly LlmRequestJournalStore journal;
    private readonly object gate = new();
    private Task backfill = Task.CompletedTask;
    private CancellationToken stop = CancellationToken.None;
    private bool started;
    private bool rerun;
    private int changePending;

    // Archive history never changes once written, so a found start or Agent stays valid.
    private readonly ConcurrentDictionary<string, (long? Start, string? Agent)> archive = new(
        StringComparer.Ordinal
    );

    internal UsageOverview(SessionManager manager, LlmRequestJournalStore journal)
    {
        this.manager = manager;
        this.journal = journal;
        journal.UsageRecorded += Recorded;
        journal.UsageLedgerFailed += Repair;
    }

    /// <summary>Coalesced (at most about once a second) notice that ledger totals changed.</summary>
    internal event Action? Changed;

    internal TimeSpan ChangeDelay { get; set; } = TimeSpan.FromSeconds(1);

    private void Recorded()
    {
        if (Interlocked.Exchange(ref changePending, 1) == 1)
            return;
        _ = Task.Delay(ChangeDelay)
            .ContinueWith(
                _ =>
                {
                    Volatile.Write(ref changePending, 0);
                    try
                    {
                        Changed?.Invoke();
                    }
                    catch
                    {
                        // Presentation listeners cannot affect accounting.
                    }
                },
                TaskScheduler.Default
            );
    }

    /// <summary>
    /// Starts the ledger backfill in the background after startup. It also prepares the ledger
    /// table, so the first live journal command does no ledger work beyond its own row.
    /// </summary>
    internal void StartBackfill(CancellationToken stop)
    {
        lock (gate)
        {
            this.stop = stop;
            started = true;
        }
        Repair();
    }

    /// <summary>Runs (or reruns after the current pass) the backfill, which also repairs the ledger.</summary>
    private void Repair()
    {
        lock (gate)
        {
            if (!started || stop.IsCancellationRequested)
                return;
            if (!backfill.IsCompleted)
            {
                rerun = true;
                return;
            }
            backfill = Task.Run(RunBackfillAsync, CancellationToken.None);
        }
    }

    private async Task RunBackfillAsync()
    {
        while (true)
        {
            try
            {
                await journal.BackfillUsageAsync(stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    "Usage ledger backfill stopped; it resumes at the next start: "
                        + MainLog.SafeFailure(error)
                );
                return;
            }
            lock (gate)
            {
                if (!rerun || stop.IsCancellationRequested)
                    return;
                rerun = false;
            }
        }
    }

    internal Task BackfillTask
    {
        get
        {
            lock (gate)
                return backfill;
        }
    }

    public async ValueTask DisposeAsync()
    {
        journal.UsageRecorded -= Recorded;
        journal.UsageLedgerFailed -= Repair;
        await BackfillTask.ConfigureAwait(false);
    }

    /// <summary>Who a recorded Session's usage belongs to now.</summary>
    internal sealed record SessionOwnerInfo(
        string? CurrentId,
        string? Agent,
        long? Start,
        string? FormerAgent
    );

    /// <summary>
    /// Resolves recorded Session IDs: the current Session (exact or through a committed alias)
    /// with its Agent and the start of its Archive history, or, for deleted Sessions, the Agent
    /// recorded in the retained Archive. Unresolvable Sessions stay unattributed rather than
    /// guessed from IDs.
    /// </summary>
    internal IReadOnlyDictionary<string, SessionOwnerInfo> DescribeSessions(
        IReadOnlyCollection<string> ids
    )
    {
        var current = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var chunk in ids.Distinct(StringComparer.Ordinal).Chunk(200))
        foreach (var (id, resolution) in manager.Catalog.ResolveMany(chunk))
            current[id] = SessionCatalog.Text(resolution["kind"]) is "exact" or "alias"
                ? SessionCatalog.Text(resolution["sessionId"])
                : null;
        var agents = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (
            var chunk in current.Values.OfType<string>().Distinct(StringComparer.Ordinal).Chunk(200)
        )
        foreach (var row in manager.Catalog.GetMany(chunk))
            agents[SessionCatalog.Text(row["id"])!] = SessionCatalog.Text(row["agent"]);
        using var db = OpenArchive();
        var result = new Dictionary<string, SessionOwnerInfo>(StringComparer.Ordinal);
        foreach (var id in ids)
        {
            var now = current.GetValueOrDefault(id);
            if (now is not null && !agents.ContainsKey(now))
                now = null;
            // A live Session's history start separates an earlier, deleted Session that used
            // the same ID; a deleted Session's Archive keeps the Agent that owned it.
            var history = ArchiveHistory(db, now ?? id);
            var former = now is null || now == id ? history.Agent : ArchiveHistory(db, id).Agent;
            result[id] = new(
                now,
                now is null ? null : agents[now],
                now is null ? null : history.Start,
                former
            );
        }
        return result;
    }

    private SqliteConnection? OpenArchive()
    {
        if (!File.Exists(manager.ArchiveDatabase))
            return null;
        var db = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = manager.ArchiveDatabase,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        db.Open();
        return db;
    }

    private (long? Start, string? Agent) ArchiveHistory(SqliteConnection? db, string id)
    {
        if (db is null)
            return (null, null);
        string canonical;
        try
        {
            canonical = SqliteArchiveMessageStore.ResolveReadOnly(db, id);
        }
        catch (InvalidDataException)
        {
            // An unreadable identity mapping leaves this Session without Archive facts.
            return (null, null);
        }
        if (archive.TryGetValue(canonical, out var cached))
            return cached;
        using var command = db.CreateCommand();
        command.CommandText =
            "SELECT timestamp,agent FROM archive_messages WHERE session_id=$id ORDER BY seq LIMIT 1";
        command.Parameters.AddWithValue("$id", canonical);
        using var reader = command.ExecuteReader();
        if (!reader.Read())
            return (null, null);
        var found = (
            (long?)Math.Floor(reader.GetDouble(0)),
            reader.IsDBNull(1) || reader.GetString(1).Length == 0 ? null : reader.GetString(1)
        );
        archive[canonical] = found;
        return found;
    }

    private sealed class Totals
    {
        internal long Requests;
        internal long Cached;
        internal long Input;
        internal long Output;
        internal long Priced;
        internal double Cost;

        internal void Add(LlmUsageCell cell)
        {
            Requests += cell.Requests;
            Cached += cell.CachedTokens;
            Input += cell.InputTokens;
            Output += cell.OutputTokens;
            Priced += cell.PricedRequests;
            Cost += cell.Cost;
        }

        internal long Tokens => Cached + Input + Output;

        internal JsonObject ToJson()
        {
            var result = new JsonObject
            {
                ["requests"] = Requests,
                ["cachedTokens"] = Cached,
                ["inputTokens"] = Input,
                ["outputTokens"] = Output,
                ["unpricedRequests"] = Requests - Priced,
            };
            // Unknown prices never become zero: cost appears only when some request had one.
            if (Priced > 0)
                result["cost"] = Cost;
            return result;
        }
    }

    private sealed record Group(string? Key, string Kind)
    {
        internal string? Label;
        internal string? Agent;
        internal readonly Totals Total = new();
        internal readonly Dictionary<int, Totals> Buckets = [];
    }

    /// <summary>The owner of one cell's rows: a current Session, a deleted one, or none.</summary>
    private sealed record Owner(string Kind, string? SessionId, string? Agent);

    internal Task<JsonObject> QueryAsync(
        IReadOnlyList<long> boundaries,
        string? groupBy,
        string? agent,
        int limit,
        CancellationToken token = default
    ) => Task.Run(() => Query(boundaries, groupBy, agent, limit), token);

    private JsonObject Query(
        IReadOnlyList<long> boundaries,
        string? groupBy,
        string? agent,
        int limit
    )
    {
        var column = groupBy switch
        {
            null or "agent" or "tree" or "session" => null,
            "model" => "model_key",
            "provider" => "provider_key",
            "purpose" => "purpose",
            _ => throw new ArgumentException("Unknown usage grouping."),
        };
        // Agent attribution, Agent filtering and Session groupings need the Session behind
        // every row; other reports aggregate directly.
        var bySession = agent is not null || groupBy is "agent" or "tree" or "session";
        IReadOnlyDictionary<string, SessionOwnerInfo> sessions =
            new Dictionary<string, SessionOwnerInfo>();
        IReadOnlyList<LlmUsageCell> cells;
        if (bySession)
        {
            sessions = DescribeSessions(journal.UsageSessions(boundaries[0], boundaries[^1]));
            var starts = sessions
                .Where(pair => pair.Value.Start is not null)
                .ToDictionary(
                    pair => pair.Key,
                    pair => pair.Value.Start!.Value,
                    StringComparer.Ordinal
                );
            cells = journal.QueryUsage(boundaries, column, bySession: true, starts);
        }
        else
            cells = journal.QueryUsage(boundaries, column);
        Owner OwnerOf(LlmUsageCell cell)
        {
            if (cell.SessionId is not { } id)
                return new("none", null, null);
            var info = sessions[id];
            return info.CurrentId is not null && !cell.BeforeSessionStart
                ? new("session", info.CurrentId, info.Agent)
                : new("deleted", null, info.FormerAgent);
        }
        var owned = cells
            .Select(cell => (Cell: cell, Owner: bySession ? OwnerOf(cell) : null))
            .ToArray();
        if (agent is not null)
            owned = owned
                .Where(item => item.Owner!.Kind != "none" && item.Owner.Agent == agent)
                .ToArray();
        var coverage = journal.UsageCoverage();
        var bucketCount = boundaries.Count - 1;
        var total = new Totals();
        var buckets = Enumerable.Range(0, bucketCount).Select(_ => new Totals()).ToArray();
        foreach (var (cell, _) in owned)
        {
            total.Add(cell);
            buckets[cell.Bucket].Add(cell);
        }
        var result = new JsonObject
        {
            ["version"] = 1,
            ["boundaries"] = new JsonArray(
                boundaries.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
            ["groupBy"] = groupBy,
            ["agent"] = agent,
            ["total"] = total.ToJson(),
            ["buckets"] = new JsonArray(
                buckets.Select(bucket => (JsonNode?)bucket.ToJson()).ToArray()
            ),
            ["coverage"] = new JsonObject
            {
                ["earliest"] = coverage.Earliest,
                ["complete"] = coverage.Complete,
            },
        };
        if (groupBy is null)
            return result;
        var groups = Grouped(owned, groupBy, agent);
        var ordered = groups
            .Values.OrderByDescending(group => group.Total.Priced > 0 ? group.Total.Cost : -1)
            .ThenByDescending(group => group.Total.Tokens)
            .ThenByDescending(group => group.Total.Requests)
            .ThenBy(group => group.Key ?? "", StringComparer.Ordinal)
            .ToArray();
        var rows = new JsonArray();
        for (var index = 0; index < Math.Min(limit, ordered.Length); index++)
        {
            var group = ordered[index];
            var row = new JsonObject
            {
                ["key"] = group.Key,
                ["kind"] = group.Kind,
                ["usage"] = group.Total.ToJson(),
            };
            if (group.Label is not null)
                row["label"] = group.Label;
            if (group.Agent is not null)
                row["agent"] = group.Agent;
            if (index < SeriesGroups)
                row["buckets"] = new JsonArray(
                    Enumerable
                        .Range(0, bucketCount)
                        .Select(bucket =>
                            (JsonNode?)
                                (
                                    group.Buckets.TryGetValue(bucket, out var value)
                                        ? value
                                        : new Totals()
                                ).ToJson()
                        )
                        .ToArray()
                );
            rows.Add(row);
        }
        result["groups"] = rows;
        result["groupCount"] = ordered.Length;
        return result;
    }

    private Dictionary<string, Group> Grouped(
        IReadOnlyList<(LlmUsageCell Cell, Owner? Owner)> owned,
        string groupBy,
        string? agent
    )
    {
        var groups = new Dictionary<string, Group>(StringComparer.Ordinal);
        Func<LlmUsageCell, Owner?, Group> describe = groupBy switch
        {
            "agent" => (_, owner) =>
                owner!.Kind == "none" ? new(null, "none")
                : owner.Agent is null ? new("", "unknown")
                : new(owner.Agent, "agent"),
            "tree" or "session" => SessionGroups(owned, groupBy == "tree", agent),
            _ => (cell, _) => new(cell.Key, cell.Key is null ? "none" : groupBy),
        };
        foreach (var (cell, owner) in owned)
        {
            var group = describe(cell, owner);
            // Keys are prefixed with their kind so null and deleted keys stay distinct.
            var identity = group.Kind + "\u0000" + (group.Key ?? "");
            if (!groups.TryGetValue(identity, out var existing))
                groups[identity] = existing = group;
            existing.Total.Add(cell);
            if (!existing.Buckets.TryGetValue(cell.Bucket, out var bucket))
                existing.Buckets[cell.Bucket] = bucket = new();
            bucket.Add(cell);
        }
        return groups;
    }

    /// <summary>
    /// Current Sessions group under themselves or their tree root; deleted Sessions are pooled
    /// per Agent, since their individual IDs no longer lead anywhere. With an Agent selected, a
    /// tree is that Agent's own part of it: its root is the highest ancestor reached through
    /// Sessions of the same Agent, so another Agent's coordinator never stands in for it.
    /// </summary>
    private Func<LlmUsageCell, Owner?, Group> SessionGroups(
        IReadOnlyList<(LlmUsageCell Cell, Owner? Owner)> owned,
        bool tree,
        string? agent
    )
    {
        var live = owned
            .Select(item => item.Owner!)
            .Where(owner => owner.Kind == "session")
            .Select(owner => owner.SessionId!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var target = live.ToDictionary(id => id, id => id, StringComparer.Ordinal);
        if (tree)
        {
            var paths = new Dictionary<string, string[]>(StringComparer.Ordinal);
            foreach (var chunk in live.Chunk(100))
            foreach (var (focus, path) in manager.Catalog.Paths(chunk))
                if (path.Length > 0)
                    paths[focus] = path;
            var pathAgents = new Dictionary<string, string?>(StringComparer.Ordinal);
            if (agent is not null)
                foreach (
                    var chunk in paths
                        .Values.SelectMany(path => path)
                        .Distinct(StringComparer.Ordinal)
                        .Chunk(200)
                )
                foreach (var row in manager.Catalog.GetMany(chunk))
                    pathAgents[SessionCatalog.Text(row["id"])!] = SessionCatalog.Text(row["agent"]);
            foreach (var (focus, path) in paths)
            {
                var root = path.Length - 1;
                if (agent is null)
                    root = 0;
                else
                    while (root > 0 && pathAgents.GetValueOrDefault(path[root - 1]) == agent)
                        root--;
                target[focus] = path[root];
            }
        }
        var rows = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in target.Values.Distinct(StringComparer.Ordinal).Chunk(200))
        foreach (var row in manager.Catalog.GetMany(chunk))
            rows[SessionCatalog.Text(row["id"])!] = row;
        var kind = tree ? "tree" : "session";
        return (_, owner) =>
        {
            if (owner!.Kind == "none")
                return new(null, "none");
            if (
                owner.Kind == "deleted"
                || !target.TryGetValue(owner.SessionId!, out var current)
                || !rows.TryGetValue(current, out var row)
            )
                return new(owner.Agent ?? "", "deleted") { Agent = owner.Agent };
            return new(current, kind)
            {
                Label = SessionCatalog.Text(row["displayName"]),
                Agent = SessionCatalog.Text(row["agent"]),
            };
        };
    }
}
