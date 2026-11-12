using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

/// <summary>
/// Best-effort record of exact recall targets: which blocks and message ranges are opened again,
/// at which level and age. It collects evidence for retention tuning (whether recently recalled
/// blocks should merge later) and is never an authority. Records hold identifiers, levels and
/// ages, not content. The file rotates once it reaches <see cref="MaxBytes"/>.
/// </summary>
internal sealed class RecallTargetLog(string dataRoot)
{
    internal const long MaxBytes = 4 * 1024 * 1024;

    private readonly string path = Path.Combine(dataRoot, "state", "logs", "recall-targets.jsonl");
    private readonly SemaphoreSlim writes = new(1, 1);

    internal string FilePath => path;

    internal Task BlockAsync(
        string caller,
        string session,
        string target,
        ArchiveBlockRecord block,
        long now
    ) =>
        AppendAsync(
            new JsonObject
            {
                ["time"] = now,
                ["caller"] = caller,
                ["session"] = session,
                ["target"] = target,
                ["blockSession"] = block.SessionId,
                ["block"] = block.Id,
                ["level"] = block.Level,
                ["sourceKind"] = block.SourceKind,
                ["rawStartSeq"] = block.RawStartSeq,
                ["rawEndSeq"] = block.RawEndSeq,
                ["contentAgeMs"] = block.RawEndTimestamp is double end ? now - (long)end : null,
                ["summaryAgeMs"] = now - block.CreatedAt,
            }
        );

    internal Task MessagesAsync(string caller, string session, long first, long last, long now) =>
        AppendAsync(
            new JsonObject
            {
                ["time"] = now,
                ["caller"] = caller,
                ["session"] = session,
                ["target"] = "messages",
                ["first"] = first,
                ["last"] = last,
            }
        );

    private async Task AppendAsync(JsonObject record)
    {
        await writes.WaitAsync().ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var info = new FileInfo(path);
            if (info.Exists && info.Length >= MaxBytes)
                File.Move(path, Path.ChangeExtension(path, ".1.jsonl"), overwrite: true);
            await File.AppendAllTextAsync(path, record.ToJsonString() + "\n", Encoding.UTF8)
                .ConfigureAwait(false);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        finally
        {
            writes.Release();
        }
    }
}
