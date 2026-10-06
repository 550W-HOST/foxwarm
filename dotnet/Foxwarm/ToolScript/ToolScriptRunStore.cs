using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.ToolScript;

internal sealed class ToolScriptRunStore(string root)
{
    private readonly string directory = Path.Combine(
        Path.GetFullPath(root),
        "state",
        "toolscript-runs"
    );
    private readonly ConcurrentDictionary<string, SemaphoreSlim> lanes = new(
        StringComparer.Ordinal
    );
    internal Func<string, AtomicJsonWriteStage, Task>? StageForTests { get; set; }

    internal async Task<IDisposable> AcquireAsync(string id, CancellationToken token)
    {
        PathFor(id);
        var lane = lanes.GetOrAdd(id, _ => new(1, 1));
        await lane.WaitAsync(token);
        return new Lane(lane);
    }

    private sealed class Lane(SemaphoreSlim lane) : IDisposable
    {
        public void Dispose() => lane.Release();
    }

    internal string PathFor(string id)
    {
        if (
            string.IsNullOrWhiteSpace(id)
            || id.Contains('/')
            || id.Contains('\\')
            || id.Contains('\0')
        )
            throw new InvalidDataException("Invalid ToolScript runId.");
        return Path.Combine(directory, id + ".json");
    }

    internal bool Exists(string id) => File.Exists(PathFor(id));

    internal async Task<JsonObject?> ReadAsync(string id, CancellationToken token)
    {
        var path = PathFor(id);
        try
        {
            return await new ToolScriptDataBudget().ReadRecordAsync(path, token);
        }
        catch (FileNotFoundException)
        {
            return null;
        }
        catch (DirectoryNotFoundException)
        {
            return null;
        }
    }

    internal async Task<IReadOnlyList<JsonObject>> ListAsync(
        string owner,
        int limit,
        string? status,
        CancellationToken token
    )
    {
        if (!Directory.Exists(directory))
            return [];
        var records = new List<JsonObject>();
        foreach (var file in Directory.EnumerateFiles(directory, "*.json"))
        {
            token.ThrowIfCancellationRequested();
            try
            {
                var budget = new ToolScriptDataBudget();
                foreach (var retained in records)
                    budget.JsonValue(retained);
                var record = await budget.ReadRecordAsync(file, token);
                if (
                    record["ownerSessionId"]?.GetValue<string>() != owner
                    || status is not null && record["status"]?.GetValue<string>() != status
                )
                    continue;
                records.Add(record);
                records.Sort(
                    (left, right) =>
                        MainToolScript
                            .Number(right["updatedAt"], 0)
                            .CompareTo(MainToolScript.Number(left["updatedAt"], 0))
                );
                if (records.Count > limit)
                    records.RemoveAt(records.Count - 1);
            }
            catch (ToolScriptDataLimitException)
            {
                throw;
            }
            catch (Exception error)
                when (error is JsonException or InvalidDataException or FileNotFoundException) { }
        }
        return records;
    }

    internal async Task WriteAsync(
        JsonObject record,
        CancellationToken token,
        ToolScriptDataBudget? activity = null
    )
    {
        var id =
            record["runId"]?.GetValue<string>()
            ?? throw new InvalidDataException("ToolScript record requires runId.");
        PathFor(id);
        var budget = activity ?? new ToolScriptDataBudget();
        budget.JsonValue(record);
        budget.Charge(ToolScriptRecordJson.ScratchReservation);
        // Existing durability primitive; streaming avoids whole-record escaped UTF-16/UTF-8 copies.
        var writer = new LinuxAtomicJsonFile(
            root,
            "state/toolscript-runs/" + id + ".json",
            stage =>
            {
                if (StageForTests is { } hook)
                    hook(id, stage).GetAwaiter().GetResult();
                var marker = Path.Combine(
                    root,
                    "state",
                    "experiment-faults",
                    "toolscript-" + id + "." + stage
                );
                if (File.Exists(marker))
                {
                    File.Delete(marker);
                    throw new IOException("Injected experimental ToolScript record write failure.");
                }
            }
        );
        await Task.Run(
            () =>
                writer.WriteStreamPayload(
                    stream =>
                    {
                        ToolScriptRecordJson.Write(stream, record, budget);
                    },
                    token
                ),
            CancellationToken.None
        );
    }

    internal static void RequireOwned(JsonObject record, string owner)
    {
        if (record["ownerSessionId"]?.GetValue<string>() != owner)
            throw new InvalidDataException("ToolScript run is not owned by this session.");
    }

    internal static void RequireUnmanaged(JsonObject record)
    {
        if (
            record["relatedManagedSessions"] is JsonArray { Count: > 0 }
            || record["waiting"]?["reason"]?.GetValue<string>() == "managed_event"
        )
            throw new NotSupportedException(
                "This Main host cannot continue or cancel a managed ToolScript run. The run, snapshot and lease references were retained."
            );
    }
}
