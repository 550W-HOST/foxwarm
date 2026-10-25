using System.Globalization;
using System.Text;
using System.Text.Json;
using Foxwarm.Models;

namespace Foxwarm;

// Only the real Main entries capture Console. One-shot CLI, native helpers and
// Vector children return before this owner is created; embedded test hosts do not
// replace process writers. Keep diagnostics out of their data/protocol streams.
internal sealed class MainLog : IDisposable
{
    private readonly TextWriter stdout = Console.Out;
    private readonly TextWriter stderr = Console.Error;
    private readonly object gate;
    private readonly StreamWriter file;
    private readonly Capture output;
    private readonly Capture error;
    private readonly bool json = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG") == "1";
    private bool failed;
    private static MainLog? active;

    // Typed lifecycle diagnostics are INFO only inside Main's capture. Outside Main, stderr
    // remains the diagnostic stream so CLI and private helper stdout framing stays intact.
    internal static void Diagnostic(string line, bool failure = false)
    {
        if (!failure && Volatile.Read(ref active) is not null)
            Console.WriteLine(line);
        else
            Console.Error.WriteLine(line);
    }

    internal static void Fatal(string stage, Exception error) =>
        Console.Error.WriteLine($"Main fatal startup failure at {stage}: {SafeFailure(error)}");

    // Do not echo configuration values, credential-bearing URLs or vendor response bodies.
    internal static string SafeFailure(Exception error)
    {
        var detail = error switch
        {
            System.Net.Http.HttpRequestException { StatusCode: { } status } =>
                $"HTTP {(int)status}",
            System.Net.Sockets.SocketException socket => socket.SocketErrorCode.ToString(),
            _ => error.GetType().Name,
        };
        return error.InnerException is { } inner ? detail + " / " + SafeFailure(inner) : detail;
    }

    internal static string Destination(ModelConfiguration? configuration, string? dataRoot = null)
    {
        var name = configuration?.AppConfiguration["bot"]?["name"]?.ToString();
        return Path.Join(
            configuration?.Paths.DataRoot ?? dataRoot!,
            "state",
            "logs",
            (string.IsNullOrEmpty(name) ? "foxwarm" : name) + ".log"
        );
    }

    internal MainLog(ModelConfiguration configuration)
    {
        var path = Destination(configuration);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        file = new StreamWriter(Foxwarm.Tools.AppendLogFile.Open(path), new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        var suppress =
            json
            || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("FOXWARM_NO_CONSOLE_LOG"));
        var console = !string.IsNullOrEmpty(
            Environment.GetEnvironmentVariable("FOXWARM_LOG_STDERR")
        )
            ? stderr
            : stdout;
        output = new Capture(this, suppress ? null : console, false);
        error = new Capture(this, suppress ? null : stderr, true);
        // Unix console writes reacquire Console.Out. Use its published monitor for
        // capture, forwarding, flush and failure fallback before any saved writer.
        var synchronizedOutput = TextWriter.Synchronized(output);
        gate = synchronizedOutput;
        Console.SetOut(synchronizedOutput);
        Console.SetError(error);
        Volatile.Write(ref active, this);
    }

    private void Record(string line, bool isError)
    {
        if (failed)
            return;
        try
        {
            var now = DateTimeOffset.Now;
            file.WriteLine(
                json
                    ? JsonSerializer.Serialize(
                        new
                        {
                            level = isError ? 50 : 30,
                            time = now.ToUnixTimeMilliseconds(),
                            pid = Environment.ProcessId,
                            hostname = Environment.MachineName,
                            msg = line,
                        }
                    )
                    : "["
                        + now.ToString("yyyy-MM-dd HH:mm:ss.fff ", CultureInfo.InvariantCulture)
                        + now.ToString("zzz", CultureInfo.InvariantCulture).Replace(":", "")
                        + "] "
                        + (isError ? "ERROR" : "INFO")
                        + ": "
                        + line
            );
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // A diagnostic failure cannot turn a completed effect into a retry.
            failed = true;
            stderr.WriteLine("Main file logging failed: " + ex.Message);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            output.Finish();
            error.Finish();
            // Channel ingress can finish a diagnostic concurrently with shutdown.
            // A writer reference already obtained by that callback must stay harmless.
            failed = true;
            Interlocked.CompareExchange(ref active, null, this);
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                file.Dispose();
            }
            catch (IOException ex)
            {
                stderr.WriteLine("Main file logging failed: " + ex.Message);
            }
        }
    }

    private sealed class Capture(MainLog owner, TextWriter? console, bool isError) : TextWriter
    {
        private readonly StringBuilder pending = new();
        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value)
        {
            lock (owner.gate)
            {
                console?.Write(value);
                if (value == '\n')
                {
                    owner.Record(pending.ToString().TrimEnd('\r'), isError);
                    pending.Clear();
                }
                else
                    pending.Append(value);
            }
        }

        public override void Write(string? value)
        {
            if (value is null)
                return;
            lock (owner.gate)
                foreach (var character in value)
                    Write(character);
        }

        public override void Flush()
        {
            lock (owner.gate)
                console?.Flush();
        }

        internal void Finish()
        {
            if (pending.Length > 0)
            {
                owner.Record(pending.ToString(), isError);
                pending.Clear();
            }
            console?.Flush();
        }
    }
}
