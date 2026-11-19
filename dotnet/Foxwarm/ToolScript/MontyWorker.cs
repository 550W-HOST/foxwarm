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
    internal static bool IsSupported =>
        (
            (OperatingSystem.IsLinux() || OperatingSystem.IsWindows())
            && RuntimeInformation.ProcessArchitecture == Architecture.X64
        )
        || (
            OperatingSystem.IsMacOS()
            && RuntimeInformation.ProcessArchitecture is Architecture.X64 or Architecture.Arm64
        );
    /// <summary>The pinned Monty release; the executable, protocol schema and snapshots all belong to it.</summary>
    internal const string Version = "1.6.0";

    /// <summary>Wire schema version declared in Configure; equals the pinned worker's PROTOCOL_VERSION.</summary>
    internal const uint ProtocolVersion = 8;

    /// <summary>Persisted identity of the snapshot a Dump produces; only the same release restores it.</summary>
    internal static readonly string SnapshotFormat = "monty-pool-snapshot-v" + Version;
    private readonly Process process;
    private readonly Task stderrDrain;
    private ulong? duration;
    private ulong used;
    private bool closed;
    internal int Pid => process.Id;

    internal MontyWorker(string binary)
    {
        if (!IsSupported)
            throw new PlatformNotSupportedException(
                "ToolScript native execution requires the packaged Monty "
                    + Version
                    + " executable for this platform."
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
        if (
            OperatingSystem.IsWindows()
            && Environment.GetEnvironmentVariable("SystemRoot") is { } systemRoot
        )
            info.Environment["SystemRoot"] = systemRoot;
        process = Process.Start(info) ?? throw new IOException("Unable to start native Monty.");
        // Native protocol carries actionable errors. Drain stderr without accumulating another unbounded string.
        stderrDrain = DrainStderrAsync();
    }

    private const int StderrTailBytes = 1024;
    private readonly object stderrGate = new();
    private byte[] stderrTail = [];

    private async Task DrainStderrAsync()
    {
        var buffer = new byte[4096];
        try
        {
            int read;
            while (
                (read = await process.StandardError.BaseStream.ReadAsync(buffer)) > 0
            )
                lock (stderrGate)
                    stderrTail = stderrTail
                        .Concat(buffer.Take(read))
                        .TakeLast(StderrTailBytes)
                        .ToArray();
        }
        catch (IOException) { }
    }

    /// <summary>The worker's last diagnostic line, such as a memory-limit abort that sends no frame.</summary>
    private async Task<string> StderrReasonAsync()
    {
        await Task.WhenAny(stderrDrain, Task.Delay(500));
        string text;
        lock (stderrGate)
            text = System.Text.Encoding.UTF8.GetString(stderrTail).Trim();
        var line = text.Split('\n').LastOrDefault()?.Trim();
        return string.IsNullOrEmpty(line) ? "" : ": " + line;
    }

    /// <summary>
    /// Opens the session. A fresh run passes its duration limit; a restored run passes none, because
    /// the limits travel inside the snapshot that the next Load restores.
    /// </summary>
    internal Task<WorkerEvent> ConfigureAsync(
        string name,
        double? seconds,
        ToolScriptDataBudget budget,
        CancellationToken token,
        bool restoring = false
    )
    {
        var limits = new ResourceLimits();
        if (!restoring)
        {
            limits.MaxMemoryBytes = 64 * 1024 * 1024;
            limits.MaxRecursionDepth = 200;
            // An absent duration limit means unlimited execution time. One run is one feed, so the
            // per-feed budget is the whole run's execution time, as the earlier session budget was.
            if (seconds is double limit)
                limits.MaxFeedDurationMicros = checked((ulong)(limit * 1_000_000));
        }
        return TurnAsync(
            new ClientRequest
            {
                Configure = new Configure
                {
                    ScriptName = name,
                    MontyVersion = Version,
                    ProtocolVersion = ProtocolVersion,
                    Limits = limits,
                    OsPolicy = HostOsPolicy(),
                },
            },
            budget,
            _ => { },
            token
        );
    }

    /// <summary>
    /// The sandbox asks the host for its clock, sleeps and random seed, and ToolScript answers
    /// "not handled", so these stay rejected as they were before the sandbox could serve them itself.
    /// </summary>
    private static OsPolicy HostOsPolicy() =>
        new()
        {
            CallHost = new Unit(),
            Sleep = new SleepMode { CallHost = new Unit() },
            RandomCallHost = new Unit(),
        };

    internal async Task<WorkerEvent> TurnAsync(
        ClientRequest request,
        ToolScriptDataBudget budget,
        Action<string> print,
        CancellationToken token
    )
    {
        if (closed)
            throw new ObjectDisposedException(nameof(MontyWorker));
        if (request.Configure is not null)
        {
            duration = request.Configure.Limits.HasMaxFeedDurationMicros
                ? request.Configure.Limits.MaxFeedDurationMicros
                : null;
            used = 0;
        }
        var executing =
            request.KindCase
            is ClientRequest.KindOneofCase.Feed
                or ClientRequest.KindOneofCase.ResumeCall
                or ClientRequest.KindOneofCase.ResumeNameLookup
                or ClientRequest.KindOneofCase.ResumeFutures;
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
                if (reply.HasMaxFeedDurationMicros)
                    duration = reply.MaxFeedDurationMicros;
                used = Math.Max(used, reply.FeedExecutionMicros);
                if (reply.KindCase == WorkerEvent.KindOneofCase.Print)
                {
                    foreach (var segment in reply.Print.Segments)
                        print(segment.Text);
                    continue;
                }
                if (reply.KindCase == WorkerEvent.KindOneofCase.FatalError)
                    throw new IOException("Monty native failure: " + reply.FatalError.Message);
                if (reply.KindCase == WorkerEvent.KindOneofCase.SessionRefused)
                    throw new IOException("Monty refused the session: " + reply.SessionRefused.Message);
                if (reply.KindCase == WorkerEvent.KindOneofCase.None)
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
        catch (EndOfStreamException)
        {
            Kill();
            throw new IOException(
                "Monty native worker exited without a result" + await StderrReasonAsync()
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
