using System.Text.Json.Nodes;
using Foxwarm.Models;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

/// <summary>
/// Installation-wide usage from the journal's derived ledger: Agent attribution for new and
/// historical rows, the startup backfill and grouped period queries for System › Usage and the
/// status bar. Read-only presentation; it never changes Session accounting or prices.
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
    private Task backfill = Task.CompletedTask;
    private int changePending;

    internal UsageOverview(SessionManager manager, LlmRequestJournalStore journal)
    {
        this.manager = manager;
        this.journal = journal;
        journal.SessionAgent = LiveAgent;
        journal.UsageRecorded += Recorded;
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

    private string? LiveAgent(string sessionId) =>
        SessionCatalog.Text(manager.Catalog.Get(sessionId)?["agent"]);

    /// <summary>
    /// Current catalog ownership (including committed aliases), then the retained Archive for
    /// deleted Sessions. Unresolvable Sessions stay unattributed rather than guessed from IDs.
    /// </summary>
    internal IReadOnlyDictionary<string, string?> ResolveAgents(IReadOnlyCollection<string> ids)
    {
        var result = new Dictionary<string, string?>(StringComparer.Ordinal);
        var live = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (id, canonical) in Canonical(ids))
        {
            result[id] = null;
            if (canonical is not null)
                live[id] = canonical;
        }
        foreach (var chunk in live.Values.Distinct(StringComparer.Ordinal).Chunk(200))
        {
            var agents = manager
                .Catalog.GetMany(chunk)
                .ToDictionary(
                    row => SessionCatalog.Text(row["id"])!,
                    row => SessionCatalog.Text(row["agent"]),
                    StringComparer.Ordinal
                );
            foreach (var (id, canonical) in live)
                if (agents.TryGetValue(canonical, out var agent))
                    result[id] = agent;
        }
        var missing = result.Where(pair => pair.Value is null).Select(pair => pair.Key).ToArray();
        if (missing.Length > 0 && File.Exists(manager.ArchiveDatabase))
        {
            using var db = new SqliteConnection(
                new SqliteConnectionStringBuilder
                {
                    DataSource = manager.ArchiveDatabase,
                    Mode = SqliteOpenMode.ReadOnly,
                    Pooling = false,
                }.ToString()
            );
            db.Open();
            using var command = db.CreateCommand();
            command.CommandText =
                "SELECT agent FROM archive_messages WHERE session_id=$id ORDER BY seq LIMIT 1";
            var parameter = command.Parameters.Add("$id", SqliteType.Text);
            foreach (var id in missing)
            {
                try
                {
                    parameter.Value = SqliteArchiveMessageStore.ResolveReadOnly(db, id);
                    if (command.ExecuteScalar() is string agent && agent.Length > 0)
                        result[id] = agent;
                }
                catch (InvalidDataException)
                {
                    // An unreadable identity mapping leaves this Session unattributed.
                }
            }
        }
        return result;
    }

    /// <summary>Maps recorded Session IDs to their current canonical ID, or null when gone.</summary>
    private Dictionary<string, string?> Canonical(IEnumerable<string> ids)
    {
        var result = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var chunk in ids.Distinct(StringComparer.Ordinal).Chunk(200))
            foreach (var (id, resolution) in manager.Catalog.ResolveMany(chunk))
                result[id] = SessionCatalog.Text(resolution["kind"]) is "exact" or "alias"
                    ? SessionCatalog.Text(resolution["sessionId"])
                    : null;
        return result;
    }

    internal void StartBackfill(CancellationToken stop)
    {
        backfill = Task.Run(
            async () =>
            {
                try
                {
                    await journal.BackfillUsageAsync(ResolveAgents, stop).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
                catch (Exception error)
                {
                    Console.Error.WriteLine(
                        "Usage ledger backfill stopped; it resumes at the next start: "
                            + MainLog.SafeFailure(error)
                    );
                }
            },
            CancellationToken.None
        );
    }

    internal Task BackfillTask => backfill;

    public async ValueTask DisposeAsync()
    {
        journal.UsageRecorded -= Recorded;
        await backfill.ConfigureAwait(false);
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

    internal async Task<JsonObject> QueryAsync(
        IReadOnlyList<long> boundaries,
        string? groupBy,
        string? agent,
        int limit,
        CancellationToken token = default
    )
    {
        var column = groupBy switch
        {
            null => null,
            "agent" => "agent",
            "tree" or "session" => "session_id",
            "model" => "model_key",
            "provider" => "provider_key",
            "purpose" => "purpose",
            _ => throw new ArgumentException("Unknown usage grouping."),
        };
        var cells = await journal
            .QueryUsageAsync(boundaries, column, agent, token)
            .ConfigureAwait(false);
        var coverage = await journal.UsageCoverageAsync(token).ConfigureAwait(false);
        var bucketCount = boundaries.Count - 1;
        var total = new Totals();
        var buckets = Enumerable.Range(0, bucketCount).Select(_ => new Totals()).ToArray();
        foreach (var cell in cells)
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
            ["buckets"] = new JsonArray(buckets.Select(bucket => (JsonNode?)bucket.ToJson()).ToArray()),
            ["coverage"] = new JsonObject
            {
                ["earliest"] = coverage.Earliest,
                ["complete"] = coverage.Complete,
            },
        };
        if (groupBy is null)
            return result;
        var groups = Grouped(cells, groupBy);
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
                            (JsonNode?)(
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

    private Dictionary<string, Group> Grouped(IReadOnlyList<LlmUsageCell> cells, string groupBy)
    {
        var groups = new Dictionary<string, Group>(StringComparer.Ordinal);
        Func<LlmUsageCell, Group> describe = groupBy switch
        {
            "agent" => cell =>
                new(cell.Key, cell.Key is null ? "none" : cell.Key.Length == 0 ? "unknown" : "agent"),
            "tree" or "session" => SessionGroups(cells, groupBy == "tree"),
            _ => cell => new(cell.Key, cell.Key is null ? "none" : groupBy),
        };
        foreach (var cell in cells)
        {
            var group = describe(cell);
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
    /// Live Sessions group under their current (or tree root) identity; deleted Sessions are
    /// pooled per recorded Agent, since their individual IDs no longer lead anywhere.
    /// </summary>
    private Func<LlmUsageCell, Group> SessionGroups(IReadOnlyList<LlmUsageCell> cells, bool tree)
    {
        var recorded = cells.Select(cell => cell.Key).OfType<string>().ToArray();
        var canonical = Canonical(recorded);
        var target = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (id, current) in canonical)
            if (current is not null)
                target[id] = current;
        if (tree)
        {
            var roots = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var chunk in target.Values.Distinct(StringComparer.Ordinal).Chunk(100))
                foreach (var (focus, path) in manager.Catalog.Paths(chunk))
                    if (path.Length > 0)
                        roots[focus] = path[0];
            foreach (var id in target.Keys.ToArray())
                if (roots.TryGetValue(target[id], out var root))
                    target[id] = root;
        }
        var rows = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in target.Values.Distinct(StringComparer.Ordinal).Chunk(200))
            foreach (var row in manager.Catalog.GetMany(chunk))
                rows[SessionCatalog.Text(row["id"])!] = row;
        var kind = tree ? "tree" : "session";
        return cell =>
        {
            if (cell.Key is not { } key)
                return new(null, "none");
            if (!target.TryGetValue(key, out var current) || !rows.TryGetValue(current, out var row))
                return new(cell.Agent ?? "", "deleted") { Agent = cell.Agent };
            return new(current, kind)
            {
                Label = SessionCatalog.Text(row["displayName"]),
                Agent = SessionCatalog.Text(row["agent"]),
            };
        };
    }
}
