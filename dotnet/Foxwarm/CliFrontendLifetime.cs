using System.IO.Pipes;

namespace Foxwarm;

// This one-shot child belongs to the frontend, unlike independent launched execs.
// Keep its lifetime pipe separate from stdin: prompt EOF is normal input completion.
internal sealed class CliFrontendLifetime : IAsyncDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly CancellationTokenSource stopping = new();
    private readonly Task disconnected;

    private CliFrontendLifetime(NamedPipeClientStream pipe)
    {
        this.pipe = pipe;
        disconnected = ObserveAsync();
    }

    internal static async Task<CliFrontendLifetime> ConnectAsync()
    {
        var name = Environment.GetEnvironmentVariable("FOXWARM_CLI_LIFETIME_PIPE");
        if (string.IsNullOrEmpty(name))
            throw new InvalidDataException("The CLI frontend lifetime pipe is required.");
        var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await pipe.ConnectAsync(timeout.Token);
            return new(pipe);
        }
        catch
        {
            pipe.Dispose();
            throw;
        }
    }

    private async Task ObserveAsync()
    {
        try
        {
            var buffer = new byte[1];
            while (await pipe.ReadAsync(buffer, stopping.Token) != 0)
            {
            }
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            return;
        }
        catch (IOException) { }
        if (!stopping.IsCancellationRequested)
            Environment.Exit(1); // Also stops work whose caller does not accept cancellation.
    }

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        await disconnected;
        pipe.Dispose();
        stopping.Dispose();
    }
}
