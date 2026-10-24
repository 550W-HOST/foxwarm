using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed partial class VectorLexicalRuntime : IAsyncDisposable
{
    private sealed class Batch
    {
        internal long Seq;
        internal long Block;
        internal long ForceSeq;
        internal long ForceBlock;
        internal bool RetryBlocked;
        internal ITimer? Timer;
        internal long? Deadline;
        internal Task? Active;
    }

    private readonly string databasePath;
    private readonly string archivePath;
    private readonly VectorConfiguration config;
    private readonly TimeProvider clock;
    private readonly object lane = new();
    private readonly Dictionary<string, Batch> states = new(StringComparer.Ordinal);
    private readonly HashSet<string> resets = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TaskCompletionSource> established = new(
        StringComparer.Ordinal
    );
    private ArchiveSearchIndex? index;
    private volatile bool ready;
    private volatile bool backfilling;
    private volatile bool rebuilding;
    private volatile bool stopping;
    private string? generation;
    private string? lastError;
    private long? lastErrorAt;
    private Task startup = Task.CompletedTask;
    private Task writer = Task.CompletedTask;
    internal Func<long>? FreeBytes { get; set; }
    internal Action? BeforePromotionValidation { get; set; }
    internal Action? BeforeLifecycleMutation { get; set; }
    internal Func<Task>? Yield { get; set; }

    internal VectorLexicalRuntime(
        string databaseRoot,
        string archivePath,
        VectorConfiguration config,
        TimeProvider clock
    )
    {
        databasePath = Path.Combine(databaseRoot, "archive-search.sqlite");
        this.archivePath = archivePath;
        this.config = config;
        this.clock = clock;
    }

    private SqliteArchiveMessageStore Archive(string id) => new(archivePath, id);

    private void Error(string code)
    {
        lastError = SafeClip(code, 96);
        lastErrorAt = clock.GetUtcNow().ToUnixTimeMilliseconds();
    }

    private static bool Rebuildable(Exception error) =>
        error is ArchiveSearchRebuildRequiredException
        || error is SqliteException sqlite
            && (
                sqlite.SqliteErrorCode is 11 or 26
                || sqlite.SqliteErrorCode == 1
                    && System.Text.RegularExpressions.Regex.IsMatch(
                        sqlite.Message.ToLowerInvariant(),
                        "not a database|file is not a database|database disk image is malformed|malformed database schema|database schema is corrupt"
                    )
            );

    private async Task YieldAsync()
    {
        if (Yield is not null)
            await Yield();
        else
            await Task.Yield();
    }

    private Task Enqueue(Func<Task> run)
    {
        lock (lane)
        {
            var previous = writer;
            var next = Task.Run(async () =>
            {
                try
                {
                    await previous;
                }
                catch { }
                await run();
            });
            writer = IgnoreAsync(next);
            return next;
        }
    }

    private static async Task IgnoreAsync(Task task)
    {
        try
        {
            await task;
        }
        catch { }
    }

    internal async Task StartAsync()
    {
        if (!config.LexicalIndex || index is not null)
            return;
        stopping = false;
        try
        {
            await OpenOrRecoverAsync();
            // Promotion can become ready while the retained shadow startup is still running.
            if (ready && startup.IsCompleted)
                startup = StartupBackfillAsync();
        }
        catch
        {
            ready = false;
            Error("LEXICAL_OPEN_FAILED");
        }
    }

    internal Task WaitForStartupAsync() => startup;

    internal async Task WaitForIdleAsync()
    {
        while (true)
        {
            Task snapshot;
            Task[] active;
            lock (lane)
            {
                snapshot = writer;
                active = states.Values.Select(state => state.Active).OfType<Task>().ToArray();
            }
            await Task.WhenAll(active.Append(snapshot).Append(startup).Select(IgnoreAsync));
            lock (lane)
                if (snapshot == writer && !states.Values.Any(state => state.Active is not null))
                    return;
        }
    }

    private async Task IndexAsync(
        string id,
        bool allowShutdown = false,
        long? seqTarget = null,
        long? blockTarget = null,
        bool allowUnavailable = false
    )
    {
        ArchiveSearchIndex? current;
        lock (lane)
            current = index;
        if (current is null || !ready && !allowUnavailable || stopping && !allowShutdown)
            return;
        ArchiveVectorCheckpoint checkpoint;
        lock (lane)
            checkpoint = current.Checkpoint(id);
        while (!stopping || allowShutdown)
        {
            var loaded = Archive(id)
                .ReadMessagesNumericRange(checkpoint.RawLastIndexedSeq + 1, null, 500);
            if (loaded.Any(row => row.SessionId != id))
                break;
            var rows = loaded.Where(row => seqTarget is null || row.Seq <= seqTarget).ToArray();
            if (rows.Length == 0)
                break;
            var documents = rows.Select(row =>
                    (
                        Row: row,
                        Text: Message(
                            row.Message,
                            rolePrefix: false,
                            substantive: true,
                            toolLimit: 0
                        )
                    )
                )
                .Where(entry => entry.Text.Length > 0)
                .Select(entry => RawDocument(entry.Row, entry.Text))
                .ToArray();
            lock (lane)
            {
                current.Raw(id, documents, rows[^1].Seq);
                checkpoint = current.Checkpoint(id);
            }
            await YieldAsync();
        }
        while (!stopping || allowShutdown)
        {
            var loaded = Archive(id)
                .ReadBlocksNumericRange(checkpoint.LastIndexedBlockId + 1, null, 100);
            if (loaded.Any(row => row.SessionId != id))
                break;
            var rows = loaded.Where(row => blockTarget is null || row.Id <= blockTarget).ToArray();
            if (rows.Length == 0)
                break;
            var documents = rows.Select(BlockDocuments).ToArray();
            lock (lane)
            {
                current.Blocks(id, documents, rows[^1].Id);
                checkpoint = current.Checkpoint(id);
            }
            await YieldAsync();
        }
    }

    private static JsonObject RawDocument(ArchiveMessageRecord row, string text) =>
        new()
        {
            ["session_id"] = row.SessionId,
            ["agent"] = row.Agent,
            ["memory_kind"] = "raw",
            ["source_key"] = row.Seq.ToString(),
            ["source_family"] = $"{row.SessionId}:raw:{row.Seq}-{row.Seq}",
            ["text"] = text,
            ["seq"] = row.Seq,
            ["start_seq"] = row.Seq,
            ["end_seq"] = row.Seq,
            ["raw_start_seq"] = row.Seq,
            ["raw_end_seq"] = row.Seq,
            ["timestamp"] = row.Timestamp,
        };

    internal static (JsonObject Block, IReadOnlyList<JsonObject> Facts) BlockDocuments(
        ArchiveBlockRecord record
    )
    {
        JsonObject Common() =>
            new()
            {
                ["session_id"] = record.SessionId,
                ["agent"] = record.Agent,
                ["source_family"] = $"{record.SessionId}:block:{record.Id}",
                ["start_seq"] = record.SourceStart,
                ["end_seq"] = record.SourceEnd,
                ["raw_start_seq"] = record.RawStartSeq,
                ["raw_end_seq"] = record.RawEndSeq,
                ["timestamp"] = record.CreatedAt,
                ["block_id"] = record.Id,
                ["block_level"] = record.Level,
            };
        var block = Common();
        block["memory_kind"] = "block";
        block["source_key"] = record.Id.ToString();
        block["text"] = record.Summary;
        var facts = (record.MemoryFacts?.OfType<JsonObject>() ?? [])
            .Select(
                (fact, index) =>
                {
                    var factText = string.Join(
                        '\n',
                        new[]
                        {
                            Trim(Text(fact["text"])),
                            Trim(Text(fact["context"])),
                            fact["attributedTo"] is null
                                ? ""
                                : "Attribution: " + Text(fact["attributedTo"]),
                        }.Where(text => text.Length > 0)
                    );
                    var hash = Hash(Text(fact["kind"]) + "\0" + Lower(factText))[..24];
                    var row = Common();
                    row["memory_kind"] = "fact";
                    row["source_key"] = $"{record.Id}:{hash}:{index}";
                    row["text"] = $"Memory fact ({Text(fact["kind"])})\n{factText}";
                    return row;
                }
            )
            .ToArray();
        return (block, facts);
    }

    private async Task StartupBackfillAsync()
    {
        backfilling = true;
        // Open/recovery gates readiness; enumeration belongs to the retained startup task.
        await Task.Yield();
        try
        {
            foreach (var entry in Archive("main").LocalVectorMaxima())
            {
                if (stopping || !ready)
                    break;
                try
                {
                    ArchiveVectorCheckpoint checkpoint;
                    lock (lane)
                        checkpoint = index!.Checkpoint(entry.SessionId);
                    if (
                        entry.MessageSeq > checkpoint.RawLastIndexedSeq
                        || entry.BlockId > checkpoint.LastIndexedBlockId
                    )
                        await Enqueue(() => IndexAsync(entry.SessionId));
                }
                catch
                {
                    Error("LEXICAL_BACKFILL_SESSION_FAILED");
                }
                await YieldAsync();
            }
        }
        catch
        {
            Error("LEXICAL_BACKFILL_FAILED");
        }
        finally
        {
            backfilling = false;
        }
    }

    private Batch State(string id)
    {
        if (!states.TryGetValue(id, out var state))
        {
            ArchiveVectorCheckpoint checkpoint;
            lock (lane)
                checkpoint = index?.Checkpoint(id) ?? new();
            states[id] = state = new()
            {
                Seq = checkpoint.RawLastIndexedSeq,
                Block = checkpoint.LastIndexedBlockId,
            };
        }
        return state;
    }

    private static void Cancel(Batch state)
    {
        state.Timer?.Dispose();
        state.Timer = null;
        state.Deadline = null;
    }

    private void Arm(string id, Batch state)
    {
        if (state.Timer is not null || !ready || stopping)
            return;
        state.Deadline = clock.GetUtcNow().AddMinutes(5).ToUnixTimeMilliseconds();
        state.Timer = clock.CreateTimer(
            _ =>
            {
                lock (lane)
                {
                    if (stopping || state.Deadline is null)
                        return;
                    Cancel(state);
                    if (state.RetryBlocked)
                    {
                        state.ForceSeq = Math.Max(state.ForceSeq, state.Seq);
                        state.ForceBlock = Math.Max(state.ForceBlock, state.Block);
                    }
                    state.RetryBlocked = false;
                    StartRun(id, state);
                }
            },
            null,
            TimeSpan.FromMinutes(5),
            Timeout.InfiniteTimeSpan
        );
    }

    private void Plan(string id, Batch state)
    {
        if (!ready || stopping)
            return;
        ArchiveVectorCheckpoint checkpoint;
        lock (lane)
            checkpoint = index?.Checkpoint(id) ?? new();
        var forced =
            state.ForceSeq > checkpoint.RawLastIndexedSeq
            || state.ForceBlock > checkpoint.LastIndexedBlockId;
        if (forced)
        {
            if (state.RetryBlocked)
                Arm(id, state);
            else
                StartRun(id, state);
        }
        else if (
            state.Block > checkpoint.LastIndexedBlockId
            || state.Seq - checkpoint.RawLastIndexedSeq >= 50
        )
            StartRun(id, state);
        else if (state.Seq > checkpoint.RawLastIndexedSeq)
            Arm(id, state);
        else
            Cancel(state);
    }

    private void StartRun(string id, Batch state)
    {
        if (state.Active is not null || !ready || stopping)
            return;
        Cancel(state);
        ArchiveVectorCheckpoint checkpoint;
        lock (lane)
            checkpoint = index!.Checkpoint(id);
        var forced =
            !state.RetryBlocked
            && (
                state.ForceSeq > checkpoint.RawLastIndexedSeq
                || state.ForceBlock > checkpoint.LastIndexedBlockId
            );
        var seq = forced ? state.ForceSeq : state.Seq;
        var block = forced ? state.ForceBlock : state.Block;
        var active = Enqueue(() => IndexAsync(id, seqTarget: seq, blockTarget: block));
        state.Active = active;
        _ = AfterRunAsync(id, state, active, forced);
    }

    private async Task AfterRunAsync(string id, Batch state, Task active, bool forced)
    {
        try
        {
            await active;
        }
        catch
        {
            lock (lane)
                if (forced)
                    state.RetryBlocked = true;
            Error("LEXICAL_INDEX_FAILED");
        }
        finally
        {
            lock (lane)
            {
                if (state.Active == active)
                    state.Active = null;
                if (states.GetValueOrDefault(id) == state)
                    Plan(id, state);
            }
        }
    }

    internal void Schedule(string id, long seq, long block)
    {
        if (!ready || stopping)
            return;
        try
        {
            lock (lane)
            {
                var state = State(id);
                state.Seq = Math.Max(state.Seq, seq);
                state.Block = Math.Max(state.Block, block);
                Plan(id, state);
            }
        }
        catch
        {
            Error("LEXICAL_SCHEDULE_FAILED");
        }
    }

    internal void Force(string id, long seq, long block)
    {
        if (!ready || stopping)
            return;
        try
        {
            lock (lane)
            {
                var state = State(id);
                state.Seq = Math.Max(state.Seq, seq);
                state.Block = Math.Max(state.Block, block);
                state.ForceSeq = Math.Max(state.ForceSeq, seq);
                state.ForceBlock = Math.Max(state.ForceBlock, block);
                state.RetryBlocked = false;
                StartRun(id, state);
            }
        }
        catch
        {
            Error("LEXICAL_FORCE_FAILED");
        }
    }

    internal JsonObject Status(string id)
    {
        var stats = Archive(id).LocalVectorStats();
        ArchiveVectorCheckpoint checkpoint;
        lock (lane)
            checkpoint = index?.Checkpoint(id) ?? new();
        long? deadline;
        lock (lane)
            deadline = states.GetValueOrDefault(id)?.Deadline;
        return new()
        {
            ["configured"] = config.LexicalIndex,
            ["ready"] = ready,
            ["backfilling"] = backfilling,
            ["rebuilding"] = rebuilding,
            ["generation"] = generation,
            ["rawLastIndexedSeq"] = checkpoint.RawLastIndexedSeq,
            ["lastIndexedBlockId"] = checkpoint.LastIndexedBlockId,
            ["latestLocalMessageSeq"] = stats.MaxSeq,
            ["latestLocalBlockId"] = stats.MaxBlockId,
            ["pendingMessageCount"] = Math.Max(0, stats.MaxSeq - checkpoint.RawLastIndexedSeq),
            ["pendingBlockCount"] = Math.Max(0, stats.MaxBlockId - checkpoint.LastIndexedBlockId),
            ["maxLatencyDeadline"] = deadline,
            ["lastErrorCode"] = lastError,
            ["lastErrorAt"] = lastErrorAt,
        };
    }

    internal Task<VectorSearchResult> QueryAsync(
        string query,
        int limit,
        VectorSearchOptions? options
    )
    {
        JsonObject Metadata(bool used = false, string? error = null) =>
            new()
            {
                ["configured"] = config.HybridSearch,
                ["ready"] = ready,
                ["used"] = used,
                ["backfilling"] = backfilling,
                ["errorCode"] = error,
            };
        if (!config.HybridSearch || !ready || index is null || rebuilding || stopping)
            return Task.FromResult(new VectorSearchResult([], Metadata(error: lastError)));
        try
        {
            IReadOnlyList<JsonObject> hits;
            lock (lane)
                hits = index.Query(query, options, Math.Clamp(limit * 4, 20, 200));
            return Task.FromResult(new VectorSearchResult(hits, Metadata(hits.Count > 0)));
        }
        catch
        {
            return Task.FromResult(new VectorSearchResult([], Metadata(error: "LEXICAL_QUERY_FAILED")));
        }
    }

    internal Task MaintenanceAsync()
    {
        if (ready && index is not null && !stopping)
            try
            {
                lock (lane)
                    index.Maintenance();
            }
            catch
            {
                Error("LEXICAL_MAINTENANCE_FAILED");
            }
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        stopping = true;
        var flushes = new List<Task>();
        lock (lane)
            foreach (var (id, state) in states)
            {
                Cancel(state);
                if (state.Active is null && ready)
                    flushes.Add(
                        Enqueue(() =>
                            IndexAsync(
                                id,
                                allowShutdown: true,
                                seqTarget: state.Seq,
                                blockTarget: state.Block
                            )
                        )
                    );
            }
        await Task.WhenAll(flushes.Select(IgnoreAsync));
        await WaitForIdleAsync();
        lock (lane)
        {
            index?.Dispose();
            index = null;
            ready = false;
        }
        lock (lane)
        {
            states.Clear();
            foreach (var pending in established.Values)
                pending.TrySetResult();
            established.Clear();
            resets.Clear();
        }
    }
}
