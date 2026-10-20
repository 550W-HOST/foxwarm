using System.Text.Json.Nodes;
using Foxwarm.Nodes;

namespace Foxwarm.Tools;

internal sealed partial class LocalExecManager
{
    private ProviderExecBackend ProviderBackend(ExecRecord record) =>
        (
            ResolveProviderBackend
            ?? throw new InvalidOperationException("Execution provider is unavailable.")
        )(record.ProviderId!, record.NodeId);

    private async Task<ExecRecord> StartProviderAsync(
        string session,
        string id,
        string command,
        string? cwd,
        ProviderExecBackend backend,
        Action beforeLaunch,
        CancellationToken hardCancellation
    )
    {
        var receipt = await backend.StartAsync(command, cwd, beforeLaunch, hardCancellation);
        return new ExecRecord(
            session,
            id,
            command,
            receipt.Cwd,
            agentForSession(session),
            backend.NodeId,
            receipt.OutputPath,
            receipt.StartedAt,
            false,
            receipt.Pid,
            ProviderId: backend.ProviderId,
            Reference: receipt.Reference
        );
    }

    private Task<JsonObject?> ProviderStatusAsync(ExecRecord record)
    {
        lock (record.Observation)
        {
            if (record.Observation.Poll is not { IsCompleted: false })
                record.Observation.Poll = PollProviderAsync(record);
            return record.Observation.Poll;
        }
    }

    private async Task<JsonObject?> PollProviderAsync(ExecRecord record)
    {
        await Task.Yield();
        try
        {
            var observation = await ProviderBackend(record).PollAsync(record.Reference!);
            if (observation.Cwd is not null)
                record.Observation.Cwd = observation.Cwd;
            return observation.Status;
        }
        catch (Exception error)
            when (error
                    is IOException
                        or InvalidOperationException
                        or System.Text.Json.JsonException
            )
        {
            // An unavailable observation is neither an exit nor permission to replay the command.
            return null;
        }
    }

    private ExecOutput.Files ProviderOutput(ExecRecord record, string? cwd, CancellationToken token)
    {
        var files = ProviderBackend(record).Files(cwd);
        return new(
            async path =>
            {
                token.ThrowIfCancellationRequested();
                return (await files.StatAsync(path, token).WaitAsync(token)).Size;
            },
            async (path, offset, count) =>
            {
                token.ThrowIfCancellationRequested();
                return await files.ReadAsync(path, offset, count, token).WaitAsync(token);
            }
        );
    }
}
