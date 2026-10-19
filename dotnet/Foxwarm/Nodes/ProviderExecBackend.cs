using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Nodes;

/// <summary>Core bridge to target process primitives; tracking and completion remain in LocalExecManager.</summary>
internal sealed class ProviderExecBackend(ExecutableNodeProvider provider, string nodeId)
{
    internal string ProviderId => provider.Id;
    internal string NodeId => nodeId;
    private string LocalId => nodeId[(provider.Id.Length + 1)..];

    internal ITargetFileOperations Files(string? cwd) =>
        new ProviderFileOperations(provider, LocalId, cwd);

    internal sealed record Started(
        string Reference,
        string OutputPath,
        string Cwd,
        long StartedAt,
        long? Pid
    );

    internal sealed record Observation(JsonObject? Status, string? Cwd);

    internal async Task<Started> StartAsync(
        string command,
        string? cwd,
        Action beforeLaunch,
        CancellationToken hardCancellation
    )
    {
        var request = new JsonObject { ["nodeId"] = LocalId, ["command"] = command };
        if (cwd is not null)
            request["cwd"] = cwd;
        beforeLaunch();
        var dispatched = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        try
        {
            var value = ExecutableNodeProvider.Object(
                await provider.RunAsync("exec-start", request, hardCancellation)
            );
            ExecutableNodeProvider.Keys(value, ["ref", "outputPath", "cwd", "startedAt", "pid"]);
            var reference = ExecutableNodeProvider.Bounded(value["ref"], 4096);
            var output = ExecutableNodeProvider.Bounded(value["outputPath"], 4096);
            var actualCwd = ExecutableNodeProvider.Bounded(value["cwd"], 4096);
            var started = Timestamp(value, "startedAt");
            long? pid = value.ContainsKey("pid") ? Integer(value["pid"]) : null;
            if (pid is <= 0)
                throw ExecutableNodeProvider.Invalid("Exec PID must be a positive integer.");
            return new(
                reference,
                output,
                actualCwd,
                started?.ToUnixTimeMilliseconds() ?? dispatched,
                pid
            );
        }
        catch (Exception error)
            when (error
                    is IOException
                        or InvalidOperationException
                        or OperationCanceledException
                        or System.Text.Json.JsonException
            )
        {
            throw new IOException(
                "Exec start did not return a usable receipt; execution outcome is unknown. Do not automatically repeat the command. "
                    + error.Message,
                error
            );
        }
    }

    internal async Task<Observation> PollAsync(string reference)
    {
        var value = ExecutableNodeProvider.Object(
            await provider.RunAsync(
                "exec-poll",
                new JsonObject { ["nodeId"] = LocalId, ["ref"] = reference },
                CancellationToken.None
            )
        );
        var state = SessionWait.Text(value["state"]);
        if (state == "running")
        {
            ExecutableNodeProvider.Keys(value, ["state", "cwd"]);
            return new(null, Cwd(value));
        }
        if (state == "lost")
        {
            ExecutableNodeProvider.Keys(value, ["state", "reason"]);
            return new(
                new JsonObject
                {
                    ["exitCode"] = null,
                    ["finishedAt"] = DateTimeOffset.UtcNow.ToString(
                        "O",
                        CultureInfo.InvariantCulture
                    ),
                    ["finishedAtIsEstimated"] = true,
                    ["error"] =
                        "Execution lost: " + ExecutableNodeProvider.Bounded(value["reason"], 4096),
                },
                null
            );
        }
        if (state != "finished" || !value.ContainsKey("exitCode"))
            throw ExecutableNodeProvider.Invalid(
                "Finished exec must report a real exit code or null."
            );
        ExecutableNodeProvider.Keys(
            value,
            ["state", "exitCode", "finishedAt", "durationMs", "cwd", "error"]
        );
        if (value["exitCode"] is not null)
            _ = Integer(value["exitCode"]);
        var finished = Timestamp(value, "finishedAt");
        var status = new JsonObject
        {
            ["exitCode"] = value["exitCode"]?.DeepClone(),
            ["finishedAt"] =
                finished?.ToString("O", CultureInfo.InvariantCulture)
                ?? DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            ["finishedAtIsEstimated"] = finished is null,
        };
        if (value.ContainsKey("durationMs"))
        {
            var duration = SessionWait.Number(value["durationMs"]);
            if (duration is null || !double.IsFinite(duration.Value) || duration < 0)
                throw ExecutableNodeProvider.Invalid("Exec durationMs must be nonnegative.");
            status["durationMs"] = duration;
        }
        if (value.ContainsKey("error"))
            status["error"] = ExecutableNodeProvider.Bounded(value["error"], 4096);
        return new(status, Cwd(value));
    }

    private static string? Cwd(JsonObject value) =>
        value.ContainsKey("cwd") ? ExecutableNodeProvider.Bounded(value["cwd"], 4096) : null;

    private static long Integer(JsonNode? value)
    {
        if (
            SessionWait.Number(value) is not double number
            || !double.IsFinite(number)
            || Math.Truncate(number) != number
            || Math.Abs(number) > 9007199254740991
        )
            throw ExecutableNodeProvider.Invalid("Exec integer is invalid.");
        return (long)number;
    }

    private static DateTimeOffset? Timestamp(JsonObject value, string key)
    {
        if (!value.ContainsKey(key))
            return null;
        if (
            SessionWait.Text(value[key]) is not { Length: <= 128 } text
            || !DateTimeOffset.TryParse(
                text,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal,
                out var timestamp
            )
        )
            throw ExecutableNodeProvider.Invalid("Exec timestamp is invalid.");
        return timestamp;
    }
}
