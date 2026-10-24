using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using static Foxwarm.Vector.VectorText;

namespace Foxwarm.Vector;

internal sealed partial class VectorRuntime : IAsyncDisposable
{
    private sealed class Batch
    {
        internal long Seq;
        internal long Block;
        internal int Tokens;
        internal Task<long>? Active;
        internal ITimer? Timer;
        internal long? Deadline;
    }

    private readonly string archivePath;
    private readonly string databaseRoot;
    private readonly VectorConfiguration config;
    private readonly HttpClient embeddings = new() { Timeout = TimeSpan.FromSeconds(60) };
    private readonly VectorOperationGate operations = new();
    private readonly object scheduling = new();
    private readonly Dictionary<string, Batch> batches = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task<long>> chains = new(StringComparer.Ordinal);
    private readonly VectorTable table = new();
    private readonly TimeProvider clock;
    private Task startup = Task.CompletedTask;
    private bool stopping;
    private VectorMaintenance? maintenance;
    internal VectorLexicalRuntime Lexical { get; }
    internal Action<string, string>? Diagnostic { get; set; }

    internal VectorRuntime(string dataRoot, VectorConfiguration config, TimeProvider? clock = null)
    {
        this.config = config;
        this.clock = clock ?? TimeProvider.System;
        archivePath = Path.Combine(dataRoot, "state", "archive-store.sqlite");
        databaseRoot = Path.Combine(dataRoot, "state", "db");
        Lexical = new(databaseRoot, archivePath, config, this.clock);
    }

    private SqliteArchiveMessageStore Archive(string id) => new(archivePath, id);

    private void Warn(string code, string session = "")
    {
        try
        {
            Diagnostic?.Invoke(code, SafeClip(session, 160));
        }
        catch { }
    }

    internal async Task StartAsync()
    {
        await table.OpenAsync(databaseRoot);
        await Lexical.StartAsync();
        maintenance = new(
            config.MaintenanceEnabled,
            clock,
            RunMaintenanceAsync,
            () => Warn("VECTOR_MAINTENANCE_FAILED")
        );
        table.MutationCompleted = maintenance.RecordMutation;
        maintenance.Start();
        startup = StartupAsync();
    }

    internal async Task WaitForStartupAsync()
    {
        await startup;
        await Lexical.WaitForStartupAsync();
    }

    private async Task StartupAsync()
    {
        // Retain startup completion without running enumeration on the readiness call stack.
        await Task.Yield();
        try
        {
            await maintenance!.StartupAsync();
            var entries = Archive("main").LocalVectorMaxima();
            var remaining = entries.ToDictionary(entry => entry.SessionId, StringComparer.Ordinal);
            var ordered = new List<ArchiveVectorMaxima>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            void Visit(ArchiveVectorMaxima entry)
            {
                if (!seen.Add(entry.SessionId))
                    return;
                if (
                    entry.ParentSessionId is { } parent
                    && remaining.TryGetValue(parent, out var ancestor)
                )
                    Visit(ancestor);
                ordered.Add(entry);
            }
            foreach (var entry in entries)
                Visit(entry);
            foreach (var entry in ordered)
            {
                if (stopping)
                    break;
                var checkpoint = Archive(entry.SessionId).VectorCheckpoint();
                if (
                    entry.MessageSeq <= checkpoint.RawLastIndexedSeq
                    && entry.BlockId <= checkpoint.LastIndexedBlockId
                )
                    continue;
                try
                {
                    await ForceAsync(entry.SessionId, entry.MessageSeq, entry.BlockId);
                }
                catch
                {
                    Warn("VECTOR_BACKFILL_SESSION_FAILED", entry.SessionId);
                }
            }
        }
        catch
        {
            Warn("VECTOR_BACKFILL_FAILED");
        }
    }

    internal async Task<float[]> EmbeddingAsync(string text, bool query = false)
    {
        var uri = new UriBuilder(config.BaseUrl!);
        uri.Path = uri.Path.TrimEnd('/') + "/embeddings";
        var input = WellFormed(Truncate((query ? QueryPrefix : "") + text));
        using var response = await embeddings.PostAsJsonAsync(
            uri.Uri,
            new { model = "qwen3-embedding:0.6b", input }
        );
        var bodyText = await response.Content.ReadAsStringAsync();
        JsonObject? body;
        try
        {
            body = JsonNode.Parse(bodyText) as JsonObject;
        }
        catch (System.Text.Json.JsonException)
        {
            throw new InvalidDataException(
                $"Embedding service returned non-JSON response ({(int)response.StatusCode}): {SafeClip(bodyText, 500)}"
            );
        }
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException(
                $"Embedding request failed ({(int)response.StatusCode}): "
                    + SafeClip(
                        body?["error"] is JsonObject error
                            ? Text(error["message"])
                            : body?["error"]?.ToJsonString() ?? bodyText,
                        500
                    )
            );
        if (
            body?["data"] is not JsonArray data
            || data.FirstOrDefault()?["embedding"] is not JsonArray values
            || values.Count == 0
            || values.Any(value => SessionWait.Number(value) is null)
        )
            throw new InvalidDataException(
                "Embedding service returned invalid embeddings payload: " + SafeClip(bodyText, 500)
            );
        return values.Select(value => (float)SessionWait.Number(value)!.Value).ToArray();
    }

    private async Task HydrateAsync(IEnumerable<JsonObject> rows)
    {
        foreach (var row in rows)
            row["vector"] = new JsonArray(
                (await EmbeddingAsync(Text(row["chunk_text"])))
                    .Select(value => (JsonNode?)JsonValue.Create((double)value))
                    .ToArray()
            );
    }

    internal JsonObject Status(string id)
    {
        var checkpoint = Archive(id).VectorCheckpoint();
        var maxima = Archive(id).LocalVectorStats();
        long? deadline;
        lock (scheduling)
            deadline = batches.GetValueOrDefault(id)?.Deadline;
        return new()
        {
            ["lastIndexedSeq"] = checkpoint.RawLastIndexedSeq,
            ["tailStartSeq"] = checkpoint.RawTailStartSeq,
            ["lastIndexedBlockId"] = checkpoint.LastIndexedBlockId,
            ["latestLocalMessageSeq"] = maxima.MaxSeq,
            ["latestLocalBlockId"] = maxima.MaxBlockId,
            ["pendingMessageCount"] = Math.Max(0, maxima.MaxSeq - checkpoint.RawLastIndexedSeq),
            ["pendingBlockCount"] = Math.Max(0, maxima.MaxBlockId - checkpoint.LastIndexedBlockId),
            ["maxLatencyDeadline"] = deadline,
            ["lexical"] = config.LexicalIndex ? Lexical.Status(id) : null,
        };
    }

    private Batch State(string id)
    {
        if (!batches.TryGetValue(id, out var state))
        {
            var checkpoint = Archive(id).VectorCheckpoint();
            batches[id] = state = new()
            {
                Seq = checkpoint.RawLastIndexedSeq,
                Block = checkpoint.LastIndexedBlockId,
            };
        }
        return state;
    }

    private static void CancelDeadline(Batch state)
    {
        state.Timer?.Dispose();
        state.Timer = null;
        state.Deadline = null;
    }

    private void Arm(string id, Batch state)
    {
        if (state.Timer is not null || stopping)
            return;
        state.Deadline = clock.GetUtcNow().AddMinutes(5).ToUnixTimeMilliseconds();
        state.Timer = clock.CreateTimer(
            _ =>
            {
                Task<long>? run = null;
                lock (scheduling)
                {
                    if (batches.GetValueOrDefault(id) != state || stopping)
                        return;
                    CancelDeadline(state);
                    run = StartRun(id, state);
                }
                _ = ObserveAsync(run, id);
            },
            null,
            TimeSpan.FromMinutes(5),
            Timeout.InfiniteTimeSpan
        );
    }

    private async Task ObserveAsync(Task<long> task, string id)
    {
        try
        {
            await task;
        }
        catch
        {
            Warn("VECTOR_INDEX_FAILED", id);
        }
    }

    internal void Schedule(string id, long seq, int tokens, long block)
    {
        Lexical.Schedule(id, seq, block);
        lock (scheduling)
        {
            if (stopping)
                return;
            var checkpoint = Archive(id).VectorCheckpoint();
            if (seq <= checkpoint.RawLastIndexedSeq && block <= checkpoint.LastIndexedBlockId)
                return;
            var state = State(id);
            if (seq > state.Seq)
            {
                if (seq - state.Seq == 1 && tokens > 0)
                    state.Tokens += tokens;
                state.Seq = seq;
            }
            state.Block = Math.Max(state.Block, block);
            Plan(id, state);
        }
    }

    private void Plan(string id, Batch state)
    {
        var checkpoint = Archive(id).VectorCheckpoint();
        if (
            state.Seq <= checkpoint.RawLastIndexedSeq
            && state.Block <= checkpoint.LastIndexedBlockId
        )
        {
            CancelDeadline(state);
            batches.Remove(id);
            return;
        }
        if (
            state.Seq - checkpoint.RawLastIndexedSeq >= 50
            || state.Tokens >= 8000
            || state.Block > checkpoint.LastIndexedBlockId
        )
            _ = ObserveAsync(StartRun(id, state), id);
        else
            Arm(id, state);
    }

    private Task<long> StartRun(string id, Batch state, bool force = false)
    {
        CancelDeadline(state);
        if (state.Active is not null && !force)
            return state.Active;
        var seq = state.Seq;
        var block = state.Block;
        state.Tokens = 0;
        var prior =
            chains.GetValueOrDefault(id)
            ?? Task.FromResult(Archive(id).VectorCheckpoint().RawLastIndexedSeq);
        Task<long>? task = null;
        task = Task.Run(async () =>
        {
            var succeeded = false;
            var indexed = 0L;
            try
            {
                try
                {
                    await prior;
                }
                catch { }
                indexed = await IndexAsync(id, seq, block);
                succeeded = true;
                return indexed;
            }
            finally
            {
                lock (scheduling)
                {
                    if (chains.GetValueOrDefault(id) == task)
                        chains.Remove(id);
                    if (batches.GetValueOrDefault(id) == state && state.Active == task)
                    {
                        state.Active = null;
                        var checkpoint = Archive(id).VectorCheckpoint();
                        if (
                            !succeeded
                            || indexed < seq
                                && state.Seq <= seq
                                && checkpoint.LastIndexedBlockId >= block
                        )
                        {
                            CancelDeadline(state);
                            batches.Remove(id);
                        }
                        else if (!stopping)
                            Plan(id, state);
                    }
                }
            }
        });
        state.Active = task;
        chains[id] = task;
        return task;
    }

    internal Task<long> ForceAsync(string id, long seq, long block)
    {
        Lexical.Force(id, seq, block);
        lock (scheduling)
        {
            if (stopping)
                throw new VectorUnavailableException(
                    "VECTOR_SHUTTING_DOWN",
                    "Vector owner is shutting down."
                );
            var state = State(id);
            state.Seq = Math.Max(state.Seq, seq);
            state.Block = Math.Max(state.Block, block);
            var checkpoint = Archive(id).VectorCheckpoint();
            if (
                state.Seq <= checkpoint.RawLastIndexedSeq
                && state.Block <= checkpoint.LastIndexedBlockId
            )
            {
                CancelDeadline(state);
                batches.Remove(id);
                return Task.FromResult(checkpoint.RawLastIndexedSeq);
            }
            // Force owns a queued target run, even when a background batch is already active.
            return StartRun(id, state, force: true);
        }
    }

    private async Task<long> IndexAsync(string id, long seqHint, long blockHint)
    {
        using var lease = await operations.EnterAsync();
        var archive = Archive(id);
        var checkpoint = archive.VectorCheckpoint();
        if (seqHint <= checkpoint.RawLastIndexedSeq && blockHint <= checkpoint.LastIndexedBlockId)
            return checkpoint.RawLastIndexedSeq;
        var stats = archive.LocalVectorStats();
        var blocks = archive.ReadBlocksRange(checkpoint.LastIndexedBlockId + 1, 9007199254740991L);
        if (stats.Count == 0 && blocks.Count == 0)
            return checkpoint.RawLastIndexedSeq;
        var next = checkpoint.RawLastIndexedSeq;
        var tail = checkpoint.RawTailStartSeq;
        if (stats.MinSeq > 0 && stats.MaxSeq > next)
        {
            var rewind =
                checkpoint.RawTailStartSeq > 0 && checkpoint.RawTailStartSeq <= stats.MaxSeq
                    ? checkpoint.RawTailStartSeq
                    : stats.MinSeq;
            var records = archive.ReadMessagesRange(rewind, 9007199254740991L);
            if (records.Count > 0)
            {
                await table.DeleteAsync(
                    $"session_id = '{Escape(id)}' AND memory_kind = 'raw' AND start_seq >= {rewind}"
                );
                var segments = VectorRows.Segments(records);
                var batchSize = int.TryParse(
                    Environment.GetEnvironmentVariable("FOXWARM_VECTOR_RAW_REBUILD_BATCH_SEGMENTS"),
                    out var size
                )
                    ? Math.Max(1, size)
                    : 16;
                next = records[^1].Seq;
                tail = segments.LastOrDefault()?.StartSeq ?? next;
                foreach (var group in segments.Chunk(batchSize))
                {
                    var rows = group.SelectMany(VectorRows.Raw).ToArray();
                    await HydrateAsync(rows);
                    await table.AddAsync(rows, merge: false);
                    next = group[^1].EndSeq;
                    tail = group[^1].StartSeq;
                    archive.SetVectorCheckpoint(raw: next, tail: tail);
                }
            }
        }
        var blockRows = blocks
            .Select(block => VectorRows.Block(block, archive))
            .OfType<JsonObject>()
            .ToArray();
        await HydrateAsync(blockRows);
        await table.AddAsync(blockRows, merge: true);
        var blockId =
            blocks.LastOrDefault()?.Id ?? Math.Max(checkpoint.LastIndexedBlockId, blockHint);
        archive.SetVectorCheckpoint(raw: next, tail: tail, block: blockId);
        return next;
    }

    internal async Task<int> IndexFactsAsync(ArchiveBlockRecord block)
    {
        var rows = VectorRows.Facts(block);
        if (rows.Count == 0)
            return 0;
        using var lease = await operations.EnterAsync();
        await HydrateAsync(rows);
        await table.AddAsync(rows, merge: true);
        return rows.Count;
    }

    internal async Task RenameAsync(string oldId, string newId)
    {
        await Lexical.RenameAsync(oldId, newId);
        lock (scheduling)
            if (batches.Remove(oldId, out var state))
                CancelDeadline(state);
        var old = Archive(oldId).VectorCheckpoint();
        var current = Archive(newId).VectorCheckpoint();
        if (old.UpdatedAt <= 0 && current.UpdatedAt <= 0)
            return;
        Archive(newId)
            .SetVectorCheckpoint(
                Math.Max(old.RawLastIndexedSeq, current.RawLastIndexedSeq),
                old.RawLastIndexedSeq > current.RawLastIndexedSeq
                    ? old.RawTailStartSeq
                    : current.RawTailStartSeq,
                Math.Max(old.LastIndexedBlockId, current.LastIndexedBlockId)
            );
        // Source moves progress/scheduler state, not persisted Lance row identities.
    }

    internal async Task ForkAsync(string id)
    {
        await Lexical.ForkAsync(id);
        if (Archive(id).ReadBranch() is { ParentSessionId: not null } branch)
            Archive(id)
                .SetVectorCheckpoint(
                    branch.MessageCap,
                    branch.MessageCap > 0 ? branch.MessageCap + 1 : 0,
                    branch.BlockCap
                );
    }

    internal async Task ResetAsync(string id)
    {
        await Lexical.ResetAsync(id);
        Task<long>? previous;
        lock (scheduling)
        {
            if (batches.Remove(id, out var state))
                CancelDeadline(state);
            previous = chains.GetValueOrDefault(id);
        }
        try
        {
            if (previous is not null)
                try
                {
                    await previous;
                }
                catch { }
            using var lease = await operations.EnterAsync();
            await table.DeleteAsync($"session_id = '{Escape(id)}'");
            Archive(id).SetVectorCheckpoint(0, 0, 0);
        }
        catch
        {
            Warn("VECTOR_DERIVED_RESET_FAILED", id);
        }
    }

    private async Task RunMaintenanceAsync(IReadOnlyList<string> triggers)
    {
        Exception? denseError = null;
        try
        {
            using var lease = await operations.EnterAsync(exclusive: true);
            if (!stopping)
                await table.MaintenanceAsync(
                    config.RetentionHours,
                    triggers.Contains("periodic", StringComparer.Ordinal)
                );
        }
        catch (Exception error)
        {
            denseError = error;
        }
        await Lexical.MaintenanceAsync();
        if (denseError is not null)
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(denseError).Throw();
    }

    internal static string Escape(string value) =>
        value.Replace("'", "''", StringComparison.Ordinal);

    public async ValueTask DisposeAsync()
    {
        Task<long>[] accepted;
        lock (scheduling)
        {
            stopping = true;
            foreach (var state in batches.Values)
                CancelDeadline(state);
            accepted = chains.Values.ToArray();
        }
        if (maintenance is not null)
            await maintenance.DisposeAsync();
        await Lexical.DisposeAsync();
        await startup;
        await Task.WhenAll(
            accepted.Select(async task =>
            {
                try
                {
                    await task;
                }
                catch { }
            })
        );
        table.Dispose();
        embeddings.Dispose();
    }
}
