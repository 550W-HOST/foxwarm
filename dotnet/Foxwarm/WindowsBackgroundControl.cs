using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace Foxwarm;

// The existing Windows source-launcher protocol is owned by Main itself, including
// headless installations. Stop closes admission through the normal host lifetime.
internal sealed class WindowsBackgroundControl : IAsyncDisposable
{
    private readonly NamedPipeServerStream pipe;
    private readonly IHostApplicationLifetime lifetime;
    private readonly string dataRoot;
    private readonly CancellationTokenSource stopping = new();
    private readonly Task server;

    private WindowsBackgroundControl(string dataRoot, IHostApplicationLifetime lifetime)
    {
        this.dataRoot = dataRoot;
        this.lifetime = lifetime;
        var name = Environment.GetEnvironmentVariable("FOXWARM_WINDOWS_CONTROL_PIPE");
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidDataException("The Windows background entry requires its data-root control pipe.");
        pipe = new NamedPipeServerStream(name, PipeDirection.InOut, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        server = ServeAsync();
    }

    internal static WindowsBackgroundControl? Start(bool enabled, string dataRoot,
        IHostApplicationLifetime lifetime)
    {
        if (!enabled)
            return null;
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("The Windows background entry requires Windows.");
        return new(dataRoot, lifetime);
    }

    private async Task ServeAsync()
    {
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                await pipe.WaitForConnectionAsync(stopping.Token);
                using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
                var command = await reader.ReadLineAsync(stopping.Token);
                var logs = Path.Combine(dataRoot, "state", "logs");
                object response = command switch
                {
                    "status" => new { ok = true, pid = Environment.ProcessId,
                        stopping = lifetime.ApplicationStopping.IsCancellationRequested,
                        logDir = logs, stdoutLog = Path.Combine(logs, "foxwarm.stdout.log"),
                        stderrLog = Path.Combine(logs, "foxwarm.stderr.log") },
                    "stop" => new { ok = true, pid = Environment.ProcessId },
                    _ => new { ok = false, error = "unknown command" },
                };
                var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response));
                await pipe.WriteAsync(bytes, stopping.Token);
                await pipe.FlushAsync(stopping.Token);
                pipe.Disconnect();
                if (command == "stop")
                    lifetime.StopApplication();
            }
            catch (OperationCanceledException) when (stopping.IsCancellationRequested)
            {
                break;
            }
            catch (IOException)
            {
                if (pipe.IsConnected)
                    pipe.Disconnect();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        await server;
        pipe.Dispose();
        stopping.Dispose();
    }
}
