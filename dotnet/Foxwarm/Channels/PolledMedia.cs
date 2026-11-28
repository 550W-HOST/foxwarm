using Foxwarm.Images;
using Foxwarm.Sessions;

namespace Foxwarm.Channels;

internal sealed class ChannelMediaFetchFailure(Exception cause) : Exception(cause.Message, cause);

/// <summary>Media failures and terminal skips live until the poll position commits. Storage
/// and admission failures retain the position without consuming a fetch attempt.</summary>
internal sealed class PolledMedia
{
    private const int AttemptLimit = 3;
    private readonly Dictionary<string, int> failures = new(StringComparer.Ordinal);

    internal async Task HandleAsync(string eventId, Func<Task> handle, ChannelHealth health)
    {
        var attempts = failures.GetValueOrDefault(eventId);
        if (attempts >= AttemptLimit) return;
        try { await handle(); }
        catch (ChannelMediaFetchFailure fetch)
        {
            var error = fetch.InnerException!;
            attempts = ChannelFailure.Refused(error) ? AttemptLimit : attempts + 1;
            failures[eventId] = attempts;
            if (attempts < AttemptLimit) throw;
            health.Log(error);
        }
        catch (ImageInputException error) when (error.InvalidRaster)
        {
            failures[eventId] = AttemptLimit;
            health.Log(error);
        }
    }

    internal static async Task<T> FetchAsync<T>(Func<Task<T>> fetch, CancellationToken stop)
    {
        try { return await fetch(); }
        catch (Exception error) when (!stop.IsCancellationRequested && error is not SessionManager.ReceivedFileTooLarge)
        {
            throw new ChannelMediaFetchFailure(error);
        }
    }

    internal void Checkpointed() => failures.Clear();
}
