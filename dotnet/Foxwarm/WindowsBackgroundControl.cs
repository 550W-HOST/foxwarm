using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace Foxwarm;

// The existing Windows source-launcher protocol is owned by Main itself, including
// headless installations. Stop closes admission through the normal host lifetime.
internal sealed class WindowsBackgroundControl : IAsyncDisposable
{
    private readonly NamedPipeServerStream first;
    private readonly string pipeName;
    private readonly IHostApplicationLifetime lifetime;
    private readonly string dataRoot;
    private readonly CancellationTokenSource stopping = new();
    private readonly Task server;

    private WindowsBackgroundControl(string dataRoot, IHostApplicationLifetime lifetime)
    {
        this.dataRoot = dataRoot;
        this.lifetime = lifetime;
        pipeName = Environment.GetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE") ?? "";
        if (string.IsNullOrWhiteSpace(pipeName))
            throw new InvalidDataException(
                "The Windows background entry requires its data-root control pipe."
            );
        first = CreatePipe();
        server = ServeAsync();
    }

    private NamedPipeServerStream CreatePipe() =>
        new(pipeName, PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

    internal static WindowsBackgroundControl? Start(
        bool enabled,
        string dataRoot,
        IHostApplicationLifetime lifetime
    )
    {
        if (!enabled)
            return null;
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException(
                "The Windows background entry requires Windows."
            );
        return new(dataRoot, lifetime);
    }

    private async Task ServeAsync()
    {
        var next = first;
        try
        {
            while (!stopping.IsCancellationRequested)
            {
                using var pipe = next;
                try
                {
                    await pipe.WaitForConnectionAsync(stopping.Token);
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested)
                {
                    break;
                }
                // Keep the published name available while the connected instance completes.
                next = CreatePipe();
                try
                {
                    using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
                    var command = await reader.ReadLineAsync(stopping.Token);
                    var logs = Path.Combine(dataRoot, "state", "logs");
                    object response = command switch
                    {
                        "status" => new
                        {
                            ok = true,
                            pid = Environment.ProcessId,
                            stopping = lifetime.ApplicationStopping.IsCancellationRequested,
                            logDir = logs,
                            stdoutLog = Path.Combine(logs, "foxwarm.stdout.log"),
                            stderrLog = Path.Combine(logs, "foxwarm.stderr.log"),
                        },
                        "stop" => new { ok = true, pid = Environment.ProcessId },
                        _ => new { ok = false, error = "unknown command" },
                    };
                    var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response));
                    await pipe.WriteAsync(bytes, stopping.Token);
                    await pipe.FlushAsync(stopping.Token);
                    // Source socket.end completes with EOF. DisconnectNamedPipe instead
                    // forces the client off with EPIPE, even after it received valid JSON.
                    if (OperatingSystem.IsWindows())
                        pipe.WaitForPipeDrain();
                    if (command == "stop")
                        lifetime.StopApplication();
                }
                catch (OperationCanceledException) when (stopping.IsCancellationRequested)
                {
                    break;
                }
                catch (IOException) { }
            }
        }
        finally
        {
            next.Dispose();
        }
    }

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        await server;
        stopping.Dispose();
    }
}
