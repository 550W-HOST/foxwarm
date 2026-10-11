using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Timers;

internal sealed class TimerStoreUnavailableException(string message) : IOException(message);

internal sealed class TimerCommittedException(string id, Exception error)
    : IOException(
        "Timer store committed, but a later durability step failed. Future registration reflects the committed store; an already started delivery is not reversed.",
        error
    )
{
    internal string TimerId { get; } = id;
}

internal sealed partial class MainTimers : IAsyncDisposable
{
    private readonly string path;
    private readonly Func<JsonObject, Task> deliver;
    private readonly object gate = new();
    private readonly SemaphoreSlim saveLane = new(1, 1);
    private readonly Dictionary<string, TimerRecord> records = new(StringComparer.Ordinal);
    private readonly HashSet<Task> deliveries = [];
    private readonly HashSet<Task> clocks = [];
    private JsonObject document = new() { ["timers"] = new JsonArray() };
    private volatile string? unavailable;
    private bool loaded;
    private volatile bool running,
        closed;
    internal Action<AtomicJsonWriteStage>? WriteStage { get; set; }
    internal Func<string, Task>? BeforeDelivery { get; set; }
    internal Action<string, Exception?>? Diagnostic { get; set; }
    private static readonly JsonSerializerOptions JsonOptions = new() { MaxDepth = int.MaxValue };
    private static readonly JsonDocumentOptions ReadOptions = new() { MaxDepth = int.MaxValue };

    internal MainTimers(string root, Func<JsonObject, Task> deliver)
    {
        path = Path.Combine(root, "state", "timers.json");
        this.deliver = deliver;
    }

    internal string? Unavailable => unavailable;

    internal async Task LoadAsync()
    {
        await saveLane.WaitAsync();
        try
        {
            if (loaded)
                return;
            loaded = true;
            try
            {
                bool exists;
                try
                {
                    _ = File.GetAttributes(path);
                    exists = true;
                }
                catch (FileNotFoundException)
                {
                    RequireKnownAbsentParent();
                    exists = false;
                }
                catch (DirectoryNotFoundException)
                {
                    RequireKnownAbsentParent();
                    exists = false;
                }
                if (exists)
                {
                    var payload = JsonNode.Parse(
                        await File.ReadAllTextAsync(path),
                        documentOptions: ReadOptions
                    );
                    if (payload is not JsonObject root || root["timers"] is not JsonArray)
                        throw new InvalidDataException(
                            "Unrecognized timers root or timers container."
                        );
                    document = root;
                }
                Publish(document, null, null);
            }
            catch (Exception error)
                when (error
                        is IOException
                            or UnauthorizedAccessException
                            or JsonException
                            or InvalidDataException
                )
            {
                unavailable = "Timer store unavailable: " + error.Message;
                Report(unavailable, error);
            }
        }
        finally
        {
            saveLane.Release();
        }
    }

    private void RequireKnownAbsentParent()
    {
        for (
            var parent = Path.GetDirectoryName(path);
            parent is not null;
            parent = Path.GetDirectoryName(parent)
        )
        {
            FileAttributes attributes;
            try
            {
                attributes = File.GetAttributes(parent);
            }
            catch (FileNotFoundException)
            {
                continue;
            }
            catch (DirectoryNotFoundException)
            {
                continue;
            }
            if (!attributes.HasFlag(FileAttributes.Directory) || !Directory.Exists(parent))
                throw new IOException("Timer store parent is unavailable.");
            return;
        }
        throw new IOException("Timer store parent is unavailable.");
    }

    private void RequireAvailable()
    {
        if (!loaded)
            throw new TimerStoreUnavailableException("Timer store has not been loaded.");
        if (unavailable is string reason)
            throw new TimerStoreUnavailableException(reason);
        if (closed)
            throw new InvalidOperationException("Timer subsystem is shutting down.");
    }

    private void Report(string message, Exception? error = null)
    {
        if (Diagnostic is { } diagnostic)
            diagnostic(message, error);
        else
            Console.Error.WriteLine(message + (error is null ? "" : " " + error));
    }

    private async Task<JsonNode?> ChangeAsync(
        string? replacement,
        TimerRecord? preserve,
        Func<JsonObject, JsonNode?> change,
        CancellationToken token = default,
        bool acceptedCompletion = false,
        Func<Task>? prepare = null,
        bool forceReplacement = false
    )
    {
        await saveLane.WaitAsync(token);
        try
        {
            if (!acceptedCompletion)
                RequireAvailable();
            else if (unavailable is not null)
                throw new TimerStoreUnavailableException(unavailable);
            token.ThrowIfCancellationRequested();
            if (prepare is not null)
                await prepare();
            var next = (JsonObject)document.DeepClone();
            var result = change(next); // No I/O in the candidate editor.
            if (JsonNode.DeepEquals(next, document) && !forceReplacement)
                return result?.DeepClone();
            AuthorityCommittedException? partial = null;
            var root = Path.GetDirectoryName(Path.GetDirectoryName(path)!)!;
            try
            {
                var payload = next.ToJsonString(JsonOptions);
                await Task.Run(() =>
                    new LinuxAtomicJsonFile(
                        root,
                        "state/timers.json",
                        stage => WriteStage?.Invoke(stage)
                    ).WriteTextPayload(payload, token)
                );
            }
            catch (AuthorityCommittedException error)
            {
                partial = error;
            }
            document = next;
            Publish(next, replacement, preserve);
            if (partial is not null)
                throw new TimerCommittedException(
                    replacement
                        ?? preserve?.Id
                        ?? (result is JsonObject row ? Text(row["id"]) : null)
                        ?? "",
                    partial
                );
            return result?.DeepClone();
        }
        finally
        {
            saveLane.Release();
        }
    }

    private void Publish(JsonObject next, string? replacement, TimerRecord? preserve)
    {
        Dictionary<string, TimerRecord> previous;
        bool arm;
        lock (gate)
        {
            previous = new(records, StringComparer.Ordinal);
            arm = running && !closed;
        }
        var groups = next["timers"]!
            .AsArray()
            .OfType<JsonObject>()
            .Where(row => Text(row["id"]) is { Length: > 0 })
            .GroupBy(row => Text(row["id"])!, StringComparer.Ordinal);
        var updated = new Dictionary<string, TimerRecord>(StringComparer.Ordinal);
        foreach (var group in groups)
        {
            var row = group.First();
            TimerRecord record;
            if (group.Count() > 1)
                record = new(row, "Timer ID is ambiguous.", ambiguous: true);
            else if (
                group.Key != replacement
                && previous.TryGetValue(group.Key, out var old)
                && (ReferenceEquals(old, preserve) || JsonNode.DeepEquals(old.Row, row))
            )
            {
                record = old;
                record.Row = row;
            }
            else
                record = Classify(row);
            updated.Add(group.Key, record);
        }
        TimerRecord[] removed,
            added;
        lock (gate)
        {
            removed = records
                .Values.Where(old =>
                    !updated.TryGetValue(old.Id, out var item) || !ReferenceEquals(old, item)
                )
                .ToArray();
            added = updated
                .Values.Where(item =>
                    !records.TryGetValue(item.Id, out var old) || !ReferenceEquals(old, item)
                )
                .ToArray();
            records.Clear();
            foreach (var pair in updated)
                records.Add(pair.Key, pair.Value);
        }
        foreach (var record in removed)
            record.Stop();
        foreach (var record in added)
        {
            if (record.Reason is string reason)
                Report("Timer '" + record.Id + "' retained unarmed: " + reason);
            else if (arm && !record.Internal)
                Start(record);
        }
    }

    internal static string? Text(JsonNode? value) => SessionWait.Text(value);

    internal static double? Number(JsonNode? value) => SessionWait.Number(value);

    internal static bool Flag(JsonNode? value) =>
        value is JsonValue scalar && scalar.TryGetValue<bool>(out var flag) && flag;

    private sealed class TimerRecord(JsonObject row, string? reason = null, bool ambiguous = false)
    {
        internal volatile JsonObject Row = row;
        internal string Id => Text(Row["id"])!;
        internal string? Reason = reason;
        internal bool Ambiguous = ambiguous;
        internal bool Internal =>
            Row.ContainsKey("waitTimeoutId") || Row.ContainsKey("waitTimeoutSeconds");
        internal bool Ordinary =>
            Text(Row["sessionId"]) is not null
            && Text(Row["message"]) is not null
            && (Number(Row["at"]) is not null) != Cron;
        internal bool Cron => Text(Row["cron"]) is string cron && SessionGoal.Trim(cron).Length > 0;
        internal CancellationTokenSource StopSource = new();
        internal Task? Clock;
        internal long? Next;

        internal void Stop() => StopSource.Cancel();
    }
}
