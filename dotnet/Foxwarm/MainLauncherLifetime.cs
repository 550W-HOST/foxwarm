using System.IO.Pipes;

namespace Foxwarm;

// Foreground package execution retains the old single-process parent lifetime:
// losing its JS entry requests ordinary Main drain, never one-shot CLI exit.
internal sealed class MainLauncherLifetime : IAsyncDisposable
{
    private readonly NamedPipeClientStream pipe;
    private readonly CancellationTokenSource disposing = new();
    private readonly CancellationTokenSource stop = new();
    private readonly Task observer;
    internal CancellationToken StopRequested => stop.Token;

    private MainLauncherLifetime(NamedPipeClientStream pipe)
    {
        this.pipe = pipe;
        observer = ObserveAsync();
    }

    internal static async Task<MainLauncherLifetime?> ConnectAsync()
    {
        var name = Environment.GetEnvironmentVariable("FOXWARM_MAIN_LIFETIME_PIPE");
        if (string.IsNullOrEmpty(name))
            return null;
        var pipe = new NamedPipeClientStream(
            ".",
            name,
            PipeDirection.InOut,
            PipeOptions.Asynchronous
        );
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
            // The launcher writes only a stop request. EOF also means stop, including
            // SIGKILL/outer-consumer termination; prompt EOF is a different stream.
            await pipe.ReadAsync(new byte[1], disposing.Token);
        }
        catch (OperationCanceledException) when (disposing.IsCancellationRequested)
        {
            return;
        }
        catch (IOException) { }
        if (!disposing.IsCancellationRequested)
            stop.Cancel();
    }

    public async ValueTask DisposeAsync()
    {
        disposing.Cancel();
        await observer;
        pipe.Dispose();
        disposing.Dispose();
        stop.Dispose();
    }
}
