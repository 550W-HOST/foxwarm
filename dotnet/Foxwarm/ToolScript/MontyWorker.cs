using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Google.Protobuf;
using Monty.V1;
using Exception = System.Exception;

namespace Foxwarm.ToolScript;

/// <summary>One owned native interpreter; waiting runs retain opaque dumps, not a live process.</summary>
internal sealed class MontyWorker : IAsyncDisposable
{
    internal const string Version = "0.0.19";
    private readonly Process process;
    private readonly Task stderrDrain;
    private ulong? duration;
    private ulong used;
    private bool closed;
    internal int Pid => process.Id;

    internal MontyWorker(string binary)
    {
        if (
            !OperatingSystem.IsLinux()
            || RuntimeInformation.ProcessArchitecture != Architecture.X64
        )
            throw new PlatformNotSupportedException(
                "ToolScript native execution requires the qualified Linux x64 GNU Monty 0.0.19 executable."
            );
        var info = new ProcessStartInfo(Path.GetFullPath(binary))
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        info.ArgumentList.Add("subprocess");
        info.Environment.Clear();
        process = Process.Start(info) ?? throw new IOException("Unable to start native Monty.");
        // Native protocol carries actionable errors. Drain stderr without accumulating another unbounded string.
        stderrDrain = DrainStderrAsync();
    }

    private async Task DrainStderrAsync()
    {
        try
        {
            await process.StandardError.BaseStream.CopyToAsync(Stream.Null);
        }
        catch (IOException) { }
    }

    internal Task<ChildEvent> ConfigureAsync(
        string name,
        double seconds,
        ToolScriptDataBudget budget,
        CancellationToken token
    ) =>
        TurnAsync(
            new ParentRequest
            {
                Configure = new Configure
                {
                    ScriptName = name,
                    MontyVersion = Version,
                    Limits = new ResourceLimits
                    {
                        MaxMemoryBytes = 64 * 1024 * 1024,
                        MaxRecursionDepth = 200,
                        MaxDurationMicros = checked((ulong)(seconds * 1_000_000)),
                    },
                },
            },
            budget,
            _ => { },
            token
        );

    internal async Task<ChildEvent> TurnAsync(
        ParentRequest request,
        ToolScriptDataBudget budget,
        Action<string> print,
        CancellationToken token
    )
    {
        if (closed)
            throw new ObjectDisposedException(nameof(MontyWorker));
        if (request.Configure is not null)
        {
            duration = request.Configure.Limits.MaxDurationMicros;
            used = 0;
        }
        var executing =
            request.KindCase
            is ParentRequest.KindOneofCase.Feed
                or ParentRequest.KindOneofCase.ResumeCall
                or ParentRequest.KindOneofCase.ResumeNameLookup
                or ParentRequest.KindOneofCase.ResumeFutures;
        using var watchdog = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (executing && duration is ulong limit)
            watchdog.CancelAfter(
                TimeSpan.FromMilliseconds(
                    Math.Min(uint.MaxValue - 1d, Math.Max(0d, (double)limit - used) / 1000 + 1000)
                )
            );
        try
        {
            var length = request.CalculateSize();
            if (length > MontyFrameBudget.MaximumFrame)
                throw new ToolScriptDataLimitException("Monty request exceeds 256 MiB.");
            budget.Charge(length);
            var body = request.ToByteArray();
            var header = new byte[4];
            BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)length);
            await process.StandardInput.BaseStream.WriteAsync(header, watchdog.Token);
            await process.StandardInput.BaseStream.WriteAsync(body, watchdog.Token);
            await process.StandardInput.BaseStream.FlushAsync(watchdog.Token);
            while (true)
            {
                await process.StandardOutput.BaseStream.ReadExactlyAsync(header, watchdog.Token);
                var size = BinaryPrimitives.ReadUInt32LittleEndian(header);
                if (size > MontyFrameBudget.MaximumFrame || size > budget.Remaining)
                    throw new ToolScriptDataLimitException(
                        "Monty response exceeds the frame or parent materialization budget."
                    );
                budget.Charge(size);
                var bytes = new byte[(int)size];
                await process.StandardOutput.BaseStream.ReadExactlyAsync(bytes, watchdog.Token);
                var reply = MontyFrameBudget.Parse(bytes, budget, frameReserved: true);
                if (reply.HasMaxDurationMicros)
                    duration = reply.MaxDurationMicros;
                used = Math.Max(used, reply.TotalExecutionMicros);
                if (reply.KindCase == ChildEvent.KindOneofCase.Print)
                {
                    print(reply.Print.Text);
                    continue;
                }
                if (reply.KindCase == ChildEvent.KindOneofCase.FatalError)
                    throw new IOException("Monty native failure: " + reply.FatalError.Message);
                if (reply.KindCase == ChildEvent.KindOneofCase.None)
                    throw new InvalidDataException("Unknown Monty protocol event.");
                return reply;
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            Kill();
            throw new TimeoutException(
                "Monty native execution watchdog expired; the worker was closed."
            );
        }
        catch
        {
            Kill();
            throw;
        }
    }

    internal void Kill()
    {
        try
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
    }

    public async ValueTask DisposeAsync()
    {
        if (closed)
            return;
        closed = true;
        try
        {
            process.StandardInput.Close();
            using var grace = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            try
            {
                await process.WaitForExitAsync(grace.Token);
            }
            catch (OperationCanceledException)
            {
                Kill();
                await process.WaitForExitAsync();
            }
            await stderrDrain;
        }
        finally
        {
            process.Dispose();
        }
    }
}
