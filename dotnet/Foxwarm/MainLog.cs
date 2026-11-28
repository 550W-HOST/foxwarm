using System.Globalization;
using System.Text;
using System.Text.Json;
using Foxwarm.Models;

namespace Foxwarm;

// Only the real Main entries capture Console. One-shot CLI, native helpers and
// Vector children return before this owner is created; embedded test hosts do not
// replace process writers. Keep diagnostics out of their data/protocol streams.
//
// The Console capture is one per process: the first MainLog installs it and the last one to
// be disposed removes it. Each MainLog is a sink (a log file, the secrets that mask its lines
// and, in hosted mode, its tenant). A line goes to the sink of the current logical flow
// (UseFor), else to the process. Several runtimes in one process therefore share
// one capture instead of wrapping each other's.
internal sealed class MainLog : IDisposable
{
    private readonly StreamWriter file;
    private readonly bool json = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG") == "1";
    private readonly Foxwarm.Secrets.InstanceSecrets? secrets;
    private readonly ProcessCapture capture;
    // Hosted mode: the tenant this sink records for; its stdout JSON lines carry it.
    private readonly string? tenant;
    private bool failed;
    private bool disposed;
    private static ProcessCapture? active;
    private static readonly object processGate = new();
    private static readonly AsyncLocal<MainLog?> current = new();

    internal string? Tenant => tenant;

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
            File.AppendAllText(path, (Volatile.Read(ref active)?.RedactLocked(line) ?? line) + "\n");
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

    internal static string Destination(ModelConfiguration? configuration, string? dataRoot = null, bool hosted = false)
    {
        var name = hosted ? null : configuration?.AppConfiguration["bot"]?["name"]?.ToString();
        return Path.Join(
            configuration?.Paths.DataRoot ?? dataRoot!,
            "state",
            "logs",
            (string.IsNullOrEmpty(name) ? "foxwarm" : name) + ".log"
        );
    }

    internal MainLog(ModelConfiguration configuration, bool jsonStdout = false, string? tenant = null)
        : this(Destination(configuration, hosted: tenant is not null), configuration.Secrets, jsonStdout, tenant) { }

    /// <summary>
    /// Opens a sink writing to <paramref name="destination"/>. The first open sink of the process
    /// installs the Console capture, and later sinks join it; they must agree on
    /// <paramref name="jsonStdout"/>, which decides what the process console receives.
    /// </summary>
    internal MainLog(
        string destination,
        Foxwarm.Secrets.InstanceSecrets? secrets,
        bool jsonStdout = false,
        string? tenant = null
    )
    {
        this.secrets = secrets;
        this.tenant = tenant;
        detached = DetachedContext(this);
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        file = new StreamWriter(
            Foxwarm.Tools.AppendLogFile.Open(destination),
            new UTF8Encoding(false)
        )
        {
            AutoFlush = true,
        };
        lock (processGate)
        {
            var existing = Volatile.Read(ref active);
            if (existing is not null && existing.JsonStdout != jsonStdout)
            {
                file.Dispose();
                throw new InvalidOperationException(
                    "A Main log with a different console format is already capturing this process."
                );
            }
            capture = existing ?? new ProcessCapture(json, jsonStdout);
            lock (capture.Gate)
                capture.Add(this);
            Volatile.Write(ref active, capture);
        }
    }

    /// <summary>
    /// Makes this sink the destination of the Console lines that the current logical flow, and
    /// the work it starts, writes from now on. Without one, a line goes to the process,
    /// and it's masked with the secrets of every open sink.
    /// </summary>
    internal void UseFor() => current.Value = this;

    // A hosted driver's lifetime belongs to this generation, not to its calling flow.
    internal void WriteErrorLine(string line)
    {
        lock (capture.Gate)
            if (!disposed)
                capture.Record(RedactOwn(line), isError: true, this);
    }

    /// <summary>
    /// Makes the current logical flow the process's own: its lines go to the process's sink (the
    /// oldest open sink with no tenant), not to a tenant's.
    /// </summary>
    internal static void UseProcess() => current.Value = null;

    // A context holding only this sink's scope, for work started without the caller's flow.
    private readonly ExecutionContext? detached;

    /// <summary>
    /// Runs <paramref name="start"/> so that the work it starts doesn't inherit the caller's
    /// execution context (its invocation, mutation and authorization scopes), but still logs to
    /// the caller's sink. Replaces <c>using (ExecutionContext.SuppressFlow())</c> at the places
    /// that start independent work.
    /// </summary>
    internal static void Detached(Action start)
    {
        if (current.Value?.detached is { } context)
            ExecutionContext.Run(context, static state => ((Action)state!)(), start);
        else if (ExecutionContext.IsFlowSuppressed())
            start();
        else
            using (ExecutionContext.SuppressFlow())
                start();
    }

    private static ExecutionContext? DetachedContext(MainLog sink)
    {
        // A thread-pool item queued without the caller's context runs in the default one, and
        // unlike a task it is never inlined into the waiting caller's context.
        ExecutionContext? context = null;
        using var done = new ManualResetEventSlim();
        ThreadPool.UnsafeQueueUserWorkItem(
            _ =>
            {
                current.Value = sink;
                context = ExecutionContext.Capture();
                done.Set();
            },
            null
        );
        done.Wait();
        return context;
    }

    // Known secret values are masked in each write before the console sees it and again in
    // each complete file line.
    private string RedactOwn(string line) => secrets?.LastBuilt.Redact(line) ?? line;

    private static string JsonLine(DateTimeOffset now, string line, bool isError, string? tenant)
    {
        var record = new System.Text.Json.Nodes.JsonObject
        {
            ["level"] = isError ? 50 : 30,
            ["time"] = now.ToUnixTimeMilliseconds(),
            ["pid"] = Environment.ProcessId,
            ["hostname"] = Environment.MachineName,
        };
        if (tenant is not null)
            record["tenant"] = tenant;
        record["msg"] = line;
        return JsonData.Serialize(record);
    }

    private void Append(DateTimeOffset now, string line, bool isError, TextWriter stderr)
    {
        if (failed)
            return;
        try
        {
            file.WriteLine(
                json
                    ? JsonLine(now, line, isError, tenant)
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
        var last = false;
        lock (processGate)
        {
            lock (capture.Gate)
            {
                if (disposed)
                    return;
                last = capture.OpenSinks == 1;
                // The last sink takes the partial lines still pending and closes the capture.
                if (last)
                    capture.Close();
                else
                    capture.Finish(this);
                // Channel ingress can finish a diagnostic concurrently with shutdown.
                // A writer reference already obtained by that callback must stay harmless.
                failed = true;
                disposed = true;
                capture.Remove(this);
                try
                {
                    file.Dispose();
                }
                catch (IOException ex)
                {
                    capture.Stderr.WriteLine("Main file logging failed: " + ex.Message);
                }
            }
            if (last)
                Interlocked.CompareExchange(ref active, null, capture);
        }
    }

    /// <summary>The process's Console capture, shared by every open <see cref="MainLog"/>.</summary>
    private sealed class ProcessCapture
    {
        private readonly TextWriter stdout = Console.Out;
        private readonly TextWriter stderr = Console.Error;
        private readonly Capture output;
        private readonly Capture error;
        private readonly List<MainLog> sinks = [];
        private bool closed;

        internal ProcessCapture(bool json, bool jsonStdout)
        {
            JsonStdout = jsonStdout;
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
            Gate = synchronizedOutput;
            Console.SetOut(synchronizedOutput);
            Console.SetError(error);
        }

        // Hosted mode: every recorded line is also one JSON line on stdout, for the container's
        // log collector, instead of the console's raw forwarding.
        internal bool JsonStdout { get; }
        internal object Gate { get; }
        internal TextWriter Stderr => stderr;
        internal int OpenSinks => sinks.Count;

        internal void Add(MainLog sink) => sinks.Add(sink);

        internal void Remove(MainLog sink) => sinks.Remove(sink);

        // The current flow's sink, if it is one of this capture's open sinks.
        // A process file sink is optional; unscoped hosted diagnostics still reach stdout.
        private MainLog? Process() =>
            sinks.FirstOrDefault(sink => sink.tenant is null);

        internal MainLog? Scoped() =>
            current.Value is { disposed: false } sink && ReferenceEquals(sink.capture, this)
                ? sink
                : null;

        // A line of a known sink is masked with that sink's secrets; a line of no known sink with
        // the secrets of every open sink, so a value is never left unmasked for want of a scope.
        internal string RedactLocked(string line)
        {
            lock (Gate)
                return Redact(line);
        }

        internal string Redact(string line) => Redact(line, Scoped());

        internal string Redact(string line, MainLog? source)
        {
            if (source is { disposed: false } scoped)
                return scoped.RedactOwn(line);
            foreach (var sink in sinks)
                line = sink.RedactOwn(line);
            return line;
        }

        // A line goes to the sink that wrote it, else (no known sink, or that sink has closed)
        // to the process log, never another tenant's file.
        internal void Record(string line, bool isError, MainLog? source)
        {
            if (closed)
                return;
            var sink = source is { disposed: false } ? source : Process();
            var now = DateTimeOffset.Now;
            if (JsonStdout)
                try
                {
                    stdout.WriteLine(JsonLine(now, line, isError, sink?.tenant));
                    stdout.Flush();
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException)
                {
                    // A closed stdout leaves the file record.
                }
            sink?.Append(now, line, isError, stderr);
        }

        // Called with the gate held by a sink that is closing: its partial lines are its own.
        internal void Finish(MainLog sink)
        {
            output.Finish(sink);
            error.Finish(sink);
        }

        // Called with the gate held by the last open sink, before it's removed.
        internal void Close()
        {
            output.Finish();
            error.Finish();
            closed = true;
            Console.SetOut(stdout);
            Console.SetError(stderr);
        }

        private sealed class Capture(ProcessCapture owner, TextWriter? console, bool isError)
            : TextWriter
        {
            // Partial lines are assembled per source, so runtimes writing at the same time never
            // join each other's text into one line, or mask it with the wrong secrets.
            private readonly Dictionary<object, (MainLog? Source, StringBuilder Text)> pending = new(
                ReferenceEqualityComparer.Instance
            );
            private static readonly object Unscoped = new();
            public override Encoding Encoding => Encoding.UTF8;

            private StringBuilder Pending(MainLog? source)
            {
                var key = (object?)source ?? Unscoped;
                if (!pending.TryGetValue(key, out var entry))
                    pending[key] = entry = (source, new StringBuilder());
                return entry.Text;
            }

            public override void Write(char value)
            {
                lock (owner.Gate)
                {
                    console?.Write(value);
                    var source = owner.Scoped();
                    Append(Pending(source), source, value);
                }
            }

            // Each write is masked as a whole before the console sees it, so console output
            // keeps its timing and a multi-line value written at once is still masked. The
            // file receives complete lines, masked again for values split across writes.
            public override void Write(string? value)
            {
                if (string.IsNullOrEmpty(value))
                    return;
                lock (owner.Gate)
                {
                    var source = owner.Scoped();
                    var masked = owner.Redact(value, source);
                    console?.Write(masked);
                    var text = Pending(source);
                    foreach (var character in masked)
                        Append(text, source, character);
                }
            }

            public override void Write(char[] buffer, int index, int count) =>
                Write(new string(buffer, index, count));

            public override void Write(ReadOnlySpan<char> buffer) => Write(new string(buffer));

            private void Append(StringBuilder text, MainLog? source, char value)
            {
                if (value == '\n')
                {
                    owner.Record(owner.Redact(text.ToString().TrimEnd('\r'), source), isError, source);
                    text.Clear();
                }
                else
                    text.Append(value);
            }

            public override void Flush()
            {
                lock (owner.Gate)
                    console?.Flush();
            }

            // Records one source's partial line, or every source's when the capture closes.
            internal void Finish(MainLog? only = null)
            {
                foreach (var (key, (source, text)) in pending.ToArray())
                {
                    if (only is not null && !ReferenceEquals(source, only))
                        continue;
                    if (text.Length > 0)
                        owner.Record(owner.Redact(text.ToString(), source), isError, source);
                    pending.Remove(key);
                }
                console?.Flush();
            }
        }
    }
}
