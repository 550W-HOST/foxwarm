namespace Foxwarm.Channels;

// What an adapter reports while it runs. Log events go to the Main server log only: transient
// or protocol-requested events that heal by themselves. Fail and Recover keep the channel's
// current runtime problem for the status list: Fail names the failing path ("Telegram
// polling") and Recover(path) clears it once that same path succeeds again.
internal sealed class ChannelHealth(
    Action<Exception> log,
    Action<string, Exception>? fail = null,
    Action<string>? recover = null
)
{
    // For hosts that only observe errors: every failure is passed to the same callback.
    internal static ChannelHealth From(Action<Exception> observe) => new(observe);

    internal void Log(Exception error) => log(error);

    internal void Fail(string path, Exception error)
    {
        if (fail is null)
            log(error);
        else
            fail(path, error);
    }

    internal void Recover(string path) => recover?.Invoke(path);

    // Runs a send: success clears the path's problem, a channel-level failure records it.
    internal async Task TrackAsync(string path, Func<Task> send, CancellationToken token = default)
    {
        try
        {
            await send();
        }
        catch (Exception error) when (ChannelFailure.ChannelLevel(error, token))
        {
            Fail(path, error);
            throw;
        }
        Recover(path);
    }
}
