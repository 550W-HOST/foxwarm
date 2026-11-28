using Foxwarm.Sessions;

namespace Foxwarm.Channels;

/// <summary>One platform fetch failure. A rejected event has exhausted its attempts or was refused by policy.</summary>
internal sealed class ChannelMediaFetchFailure(Exception cause, bool rejected) : Exception(cause.Message, cause)
{
    internal bool Rejected { get; } = rejected;
}

/// <summary>Retries fetches within the same poll position. The Session's storage and admission
/// never run inside a fetch; an unavailable authority must not spend this event's attempts.</summary>
internal sealed class PolledMedia
{
    private readonly Dictionary<string, int> failures = new(StringComparer.Ordinal);

    internal async Task<T> FetchAsync<T>(string eventId, Func<Task<T>> fetch, CancellationToken stop)
    {
        try
        {
            return await fetch();
        }
        catch (Exception error) when (!stop.IsCancellationRequested && error is not SessionManager.ReceivedFileTooLarge)
        {
            var attempts = failures.GetValueOrDefault(eventId) + 1;
            failures[eventId] = attempts;
            throw new ChannelMediaFetchFailure(error, ChannelFailure.Refused(error) || attempts >= 3);
        }
    }

    internal static bool Rejected(Exception error) =>
        error is ChannelMediaFetchFailure { Rejected: true } or Foxwarm.Images.ImageInputException { InvalidRaster: true };

    internal void Checkpointed() => failures.Clear();
}
