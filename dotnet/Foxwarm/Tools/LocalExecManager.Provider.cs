using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.ToolScript;

namespace Foxwarm.Tools;

internal sealed partial class LocalExecManager
{
    private async Task<ExecRecord> LaunchProviderAsync(
        ExecRecord allocated,
        ProviderExecBackend backend,
        string? cwd,
        Action beforeLaunch,
        CancellationToken hardCancellation
    )
    {
        var receipt = await backend.StartAsync(
            allocated.Command,
            cwd,
            beforeLaunch,
            hardCancellation
        );
        var record = allocated with
        {
            ProviderId = backend.ProviderId,
            NodeId = backend.NodeId,
            Reference = receipt.Reference,
            LogPath = receipt.OutputPath,
            Cwd = receipt.Cwd,
            StartedAt = receipt.StartedAt,
            ProviderPid = receipt.Pid,
        };
        record.KnownCwd = receipt.Cwd;
        await AtomicWriteAsync(
            Path.Combine(record.Directory, "meta.json"),
            JsonSerializer.Serialize(record) + "\n"
        );
        await AtomicWriteAsync(
            Path.Combine(record.Directory, "tracking.json"),
            "{\"notify\":false}\n"
        );
        pending[Key(record.SessionId, record.Id)] = record;
        return record;
    }

    private Task<JsonObject?> ProviderStatusAsync(ExecRecord record)
    {
        lock (record.Observation)
        {
            if (record.Observation.Status is not null)
                return Task.FromResult<JsonObject?>(record.Observation.Status);
            if (record.Observation.Poll is not { IsCompleted: false })
                record.Observation.Poll = PollProviderAsync(record);
            return record.Observation.Poll;
        }
    }

    private async Task<JsonObject?> PollProviderAsync(ExecRecord record)
    {
        // Start outside the observation lock, including for already persisted terminal metadata.
        await Task.Yield();
        var statusPath = Path.Combine(record.Directory, "status.json");
        if (File.Exists(statusPath))
        {
            var saved = JsonNode.Parse(await File.ReadAllTextAsync(statusPath))!.AsObject();
            record.Observation.Status = saved;
            return saved;
        }
        var observation = await ProviderBackend(record).PollAsync(record.Reference!);
        if (observation.Cwd is not null && observation.Cwd != record.KnownCwd)
        {
            record.KnownCwd = observation.Cwd;
            await AtomicWriteAsync(
                Path.Combine(record.Directory, "meta.json"),
                JsonSerializer.Serialize(record) + "\n"
            );
        }
        if (observation.Status is not null)
        {
            await AtomicWriteAsync(statusPath, observation.Status.ToJsonString());
            record.Observation.Status = observation.Status;
        }
        return observation.Status;
    }

    private async Task<JsonObject> ExecuteProviderAsync(
        string sessionId,
        string command,
        JsonObject args,
        double waitSeconds,
        string warning,
        ProviderExecBackend backend,
        string? sessionCwd,
        CancellationToken stop,
        Action? beforeLaunch,
        CancellationToken hardCancellation,
        Action<string, string>? observeCwd,
        ToolScriptDataBudget? programmatic,
        Func<string>? cancellationSource
    )
    {
        if (string.IsNullOrWhiteSpace(command))
            return Error("invalid_tool_arguments", "exec requires command.");
        var cwd = args["cwd"]?.GetValue<string>() ?? sessionCwd;
        if (cwd is not null && cwd.Length == 0)
            return Error("invalid_tool_arguments", "Exec cwd must be a non-empty string.");
        var record = await StartAsync(
            sessionId,
            command,
            "",
            "",
            stop,
            backend,
            cwd,
            beforeLaunch,
            hardCancellation
        );
        var clock = Stopwatch.StartNew();
        var waitBudget = TimeSpan.FromSeconds(waitSeconds);
        using var foreground = CancellationTokenSource.CreateLinkedTokenSource(
            stop,
            hardCancellation
        );
        foreground.CancelAfter(waitBudget);
        JsonObject? status = null;
        try
        {
            while (!foreground.IsCancellationRequested)
            {
                try
                {
                    status = await ReadStatusAsync(record).WaitAsync(foreground.Token);
                    if (status is not null)
                        break;
                }
                catch (Exception error)
                    when (error is IOException or InvalidOperationException or JsonException)
                { /* Metadata unavailability is not an exit or a lost job. */
                }
                await Task.Delay(100, foreground.Token);
            }
        }
        catch (OperationCanceledException) when (foreground.IsCancellationRequested)
        { /* Only this observation ended; the shared query and command remain independent. */
        }
        if (status is null)
        {
            record = record with { Notify = true };
            await AtomicWriteAsync(
                Path.Combine(record.Directory, "tracking.json"),
                "{\"notify\":true}\n"
            );
            pending[Key(sessionId, record.Id)] = record;
        }
        using var output = CancellationTokenSource.CreateLinkedTokenSource(stop, hardCancellation);
        var outputBudget = status is null
            ? TimeSpan.FromMilliseconds(500)
            : waitBudget - clock.Elapsed;
        if (outputBudget <= TimeSpan.Zero)
            output.Cancel();
        else
            output.CancelAfter(outputBudget);
        try
        {
            var capture = await CaptureProviderAsync(record, programmatic, output.Token);
            var text = capture.Display;
            if (capture.Size == 0)
                text = status is null ? "(Command started, no output yet)" : "(No output)";
            var footer = status is null
                ? $"{(stop.IsCancellationRequested || hardCancellation.IsCancellationRequested ? $"[Foreground wait ended by {cancellationSource?.Invoke() ?? "Stop or Run queued"}]" : $"[Process running longer than {waitSeconds.ToString(CultureInfo.InvariantCulture)}s]")} Switched to background. A completion event will arrive in this Session.\nElapsed: {ExecDuration.Format(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - record.StartedAt) ?? "unknown"}"
                : $"Exit code: {ExitCode(status)}\nDuration: {CompletedDuration(record, status)}";
            if (SessionWait.Text(status?["error"]) is string error)
                footer += "\n" + error;
            if (capture.EndedWithLf == false && capture.Size > 0)
                footer += status is null
                    ? "\nCaptured partial output does not end with a newline."
                    : "\nCaptured output does not end with a newline.";
            var result = new JsonObject
            {
                ["output"] =
                    text
                    + (text.EndsWith('\n') ? "" : "\n")
                    + "---\n"
                    + footer
                    + $"\nexecId: {record.Id}\nNode: `{record.NodeId}`\nLog: {record.LogPath}\nRead complete output with read_exec({{execId: \"{record.Id}\"}})."
                    + (warning.Length == 0 ? "" : "\n" + warning.TrimEnd()),
            };
            if (programmatic is not null)
            {
                result["status"] = status is null ? "running" : "completed";
                result["execId"] = record.Id;
                result["logPath"] = record.LogPath;
                if (status is not null)
                    result["exitCode"] = status["exitCode"]?.DeepClone();
                result["truncated"] = capture.Content is null;
                if (capture.Size is long size)
                    result["sizeBytes"] = size;
                if (capture.Content is not null)
                    result["content"] = Encoding.UTF8.GetString(capture.Content);
            }
            if (record.KnownCwd is string known)
                observeCwd?.Invoke(record.Cwd, known);
            return result;
        }
        finally
        {
            if (status is not null)
                await FinalizeForegroundAsync(record);
        }
    }

    private sealed record ProviderCapture(
        string Display,
        byte[]? Content,
        long? Size,
        bool? EndedWithLf
    );

    private async Task<ProviderCapture> CaptureProviderAsync(
        ExecRecord record,
        ToolScriptDataBudget? budget,
        CancellationToken token
    )
    {
        try
        {
            token.ThrowIfCancellationRequested();
            var files = ProviderBackend(record).Files(record.Cwd);
            var stat = await files.StatAsync(record.LogPath!, token).WaitAsync(token);
            async Task<byte[]> Read(long offset, int count)
            {
                token.ThrowIfCancellationRequested();
                var bytes = await files
                    .ReadAsync(record.LogPath!, offset, count, token)
                    .WaitAsync(token);
                if (bytes.Length != count)
                    throw new IOException("Execution output snapshot is incomplete.");
                return bytes;
            }
            if (stat.Size > 1048576)
            {
                var head = await Read(0, 5000);
                var tail = await Read(stat.Size - 5000, 5000);
                return new(
                    BoundedTextExcerpt.Format(
                        head,
                        tail,
                        stat.Size,
                        stat.Size,
                        record.LogPath!,
                        "command output"
                    ),
                    null,
                    stat.Size,
                    tail[^1] == '\n'
                );
            }
            budget?.Charge(checked(8 * stat.Size + 65536));
            var content = await Read(0, (int)stat.Size);
            var rendered = RenderBytes(content, DisplayChars);
            var sampleSize = Math.Min(5000, content.Length / 2);
            var display =
                content.Length > DisplayChars || rendered.Consumed < content.Length
                    ? BoundedTextExcerpt.Format(
                        content[..sampleSize],
                        content[^sampleSize..],
                        stat.Size,
                        stat.Size,
                        record.LogPath!,
                        "command output"
                    )
                    : rendered.Text;
            return new(
                display,
                content,
                stat.Size,
                content.Length > 0 ? content[^1] == '\n' : null
            );
        }
        catch (Exception error)
            when (error is not ToolScriptDataLimitException
                && error
                    is IOException
                        or InvalidOperationException
                        or OperationCanceledException
                        or JsonException
            )
        {
            return new("(Command output unavailable)", null, null, null);
        }
    }

    private async Task<JsonObject> ProviderPageAsync(
        ExecRecord record,
        long offset,
        int count,
        CancellationToken token
    )
    {
        // read_exec keeps its byte pagination contract; it does not rediscover an admitted job.
        JsonObject? status = null;
        var queryUnavailable = false;
        using var bound = CancellationTokenSource.CreateLinkedTokenSource(token);
        bound.CancelAfter(TimeSpan.FromSeconds(5));
        try
        {
            status = await ReadStatusAsync(record).WaitAsync(bound.Token);
        }
        catch (Exception error)
            when (error
                    is IOException
                        or InvalidOperationException
                        or OperationCanceledException
                        or JsonException
            )
        {
            queryUnavailable = true;
        }
        try
        {
            bound.Token.ThrowIfCancellationRequested();
            var files = ProviderBackend(record).Files(record.Cwd);
            var stat = await files.StatAsync(record.LogPath!, bound.Token).WaitAsync(bound.Token);
            var requested = (int)Math.Min(count, Math.Max(0, stat.Size - offset));
            var bytes = await files
                .ReadAsync(record.LogPath!, offset, requested, bound.Token)
                .WaitAsync(bound.Token);
            if (requested > 0 && bytes.Length == 0)
                throw new IOException("Execution output snapshot is incomplete.");
            var rendered = RenderBytes(bytes, DisplayChars);
            return new JsonObject
            {
                ["status"] =
                    queryUnavailable ? "unknown"
                    : status is null ? "running"
                    : "finished",
                ["exitCode"] = status?["exitCode"]?.DeepClone(),
                ["error"] =
                    status?["error"]?.DeepClone()
                    ?? (
                        queryUnavailable
                            ? JsonValue.Create("Execution metadata unavailable.")
                            : null
                    ),
                ["output"] = rendered.Text,
                ["offset"] = offset,
                ["truncated"] = bytes.Length < requested || rendered.Consumed < bytes.Length,
                ["nextOffset"] =
                    offset + rendered.Consumed < stat.Size ? offset + rendered.Consumed : null,
                ["totalBytes"] = stat.Size,
            };
        }
        catch (Exception error)
            when (error
                    is IOException
                        or InvalidOperationException
                        or OperationCanceledException
                        or JsonException
            )
        {
            return new JsonObject
            {
                ["status"] =
                    queryUnavailable ? "unknown"
                    : status is null ? "running"
                    : "finished",
                ["exitCode"] = status?["exitCode"]?.DeepClone(),
                ["error"] =
                    status?["error"]?.DeepClone()
                    ?? (
                        queryUnavailable
                            ? JsonValue.Create("Execution metadata unavailable.")
                            : null
                    ),
                ["output"] = "(Command output unavailable)",
                ["truncated"] = true,
                ["offset"] = offset,
            };
        }
    }
}
