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
    private bool disposed;
    private static MainLog? active;
    private readonly Foxwarm.Secrets.InstanceSecrets? secrets;
    // Hosted mode: every recorded line is also one JSON line on stdout, for the container's log
    // collector, instead of the console's raw forwarding.
    private readonly bool jsonStdout;

    // Typed lifecycle diagnostics are INFO only inside Main's capture. Outside Main, stderr
    // remains the diagnostic stream so CLI and private helper stdout framing stays intact.
    internal static void Diagnostic(string line, bool failure = false)
    {
        if (!failure && Volatile.Read(ref active) is not null)
            Console.WriteLine(line);
        else
            Console.Error.WriteLine(line);
    }

    internal const string StartupFailureLogVariable = "FOXWARM_STARTUP_FAILURE_LOG";
    private static string? startupFailureLog;

    // A launcher whose console can lose the last output of a Main that exits at once (tmux
    // discards what it has not read from an exited pane) names a file for the fatal line.
    // Removed from the environment at entry, so no process Main starts inherits it.
    internal static void TakeStartupFailureLog()
    {
        var path = Environment.GetEnvironmentVariable(StartupFailureLogVariable);
        Environment.SetEnvironmentVariable(StartupFailureLogVariable, null);
        startupFailureLog = string.IsNullOrWhiteSpace(path) ? null : path;
    }

    internal static void Fatal(string stage, Exception error)
    {
        var line = $"Main fatal startup failure at {stage}: {SafeFailure(error)}";
        Console.Error.WriteLine(line);
        if (startupFailureLog is not { } path)
            return;
        try
        {
            File.AppendAllText(path, (Volatile.Read(ref active)?.Redact(line) ?? line) + "\n");
        }
        catch (Exception ex)
            when (ex
                    is IOException
                        or UnauthorizedAccessException
                        or ArgumentException
                        or NotSupportedException
            )
        {
            Console.Error.WriteLine("Main could not record the startup failure: " + ex.Message);
        }
    }

    // Do not echo configuration values, credential-bearing URLs or vendor response bodies.
    internal static string SafeFailure(Exception error)
    {
        if (error is Foxwarm.Sessions.SessionAuthorityIdentityException identity)
            return error.GetType().Name + ": " + identity.SafeDetail;
        if (error is Foxwarm.Sessions.SessionAuthorityUnavailableException unavailable)
            return error.GetType().Name
                + ": "
                + unavailable.Diagnostic.Format(unavailable.SessionId);
        if (
            error
            is Foxwarm.Secrets.SecretUnavailableException
                or Foxwarm.Secrets.SecretStoreLockedException
                or ControlPipeUnavailableException
                or InstallationLockedException
        )
            return error.GetType().Name + ": " + error.Message;
        if (Foxwarm.Sessions.SessionAuthorityErrors.Detail(error) is { } diagnostic)
            return error.GetType().Name + ": " + diagnostic.Format();
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

    internal MainLog(ModelConfiguration configuration, bool jsonStdout = false)
    {
        this.jsonStdout = jsonStdout;
        secrets = configuration.Secrets;
        var path = Destination(configuration);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        file = new StreamWriter(Foxwarm.Tools.AppendLogFile.Open(path), new UTF8Encoding(false))
        {
            AutoFlush = true,
        };
        var suppress =
            json
            || jsonStdout
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

    // Known secret values are masked in each write before the console sees it and again in
    // each complete file line.
    private string Redact(string line) => secrets?.LastBuilt.Redact(line) ?? line;

    private void Record(string line, bool isError)
    {
        if (disposed || failed && !jsonStdout)
            return;
        var now = DateTimeOffset.Now;
        string JsonLine() =>
            JsonData.Serialize(
                new System.Text.Json.Nodes.JsonObject
                {
                    ["level"] = isError ? 50 : 30,
                    ["time"] = now.ToUnixTimeMilliseconds(),
                    ["pid"] = Environment.ProcessId,
                    ["hostname"] = Environment.MachineName,
                    ["msg"] = line,
                }
            );
        if (jsonStdout)
            try
            {
                stdout.WriteLine(JsonLine());
                stdout.Flush();
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                // A closed stdout leaves the file record.
            }
        if (failed)
            return;
        try
        {
            file.WriteLine(
                json
                    ? JsonLine()
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
            disposed = true;
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
                Append(value);
            }
        }

        // Each write is masked as a whole before the console sees it, so console output
        // keeps its timing and a multi-line value written at once is still masked. The
        // file receives complete lines, masked again for values split across writes.
        public override void Write(string? value)
        {
            if (string.IsNullOrEmpty(value))
                return;
            lock (owner.gate)
            {
                var masked = owner.Redact(value);
                console?.Write(masked);
                foreach (var character in masked)
                    Append(character);
            }
        }

        public override void Write(char[] buffer, int index, int count) =>
            Write(new string(buffer, index, count));

        public override void Write(ReadOnlySpan<char> buffer) => Write(new string(buffer));

        private void Append(char value)
        {
            if (value == '\n')
            {
                owner.Record(owner.Redact(pending.ToString().TrimEnd('\r')), isError);
                pending.Clear();
            }
            else
                pending.Append(value);
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
                owner.Record(owner.Redact(pending.ToString()), isError);
                pending.Clear();
            }
            console?.Flush();
        }
    }
}
