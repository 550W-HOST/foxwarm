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
    private readonly object gate = new();
    private readonly StreamWriter file;
    private readonly Capture output;
    private readonly Capture error;
    private readonly bool json = Environment.GetEnvironmentVariable("FOXWARM_SYNC_FILE_LOG") == "1";
    private bool failed;

    internal static string Destination(ModelConfiguration? configuration, string? dataRoot = null)
    {
        var name = configuration?.AppConfiguration["bot"]?["name"]?.ToString();
        return Path.Join(configuration?.Paths.DataRoot ?? dataRoot!, "state", "logs", (string.IsNullOrEmpty(name) ? "foxwarm" : name) + ".log");
    }

    internal MainLog(ModelConfiguration configuration)
    {
        var path = Destination(configuration);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        file = new StreamWriter(Foxwarm.Tools.AppendLogFile.Open(path), new UTF8Encoding(false)) { AutoFlush = true };
        var suppress = json || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("FOXWARM_NO_CONSOLE_LOG"));
        var console = !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("FOXWARM_LOG_STDERR")) ? stderr : stdout;
        output = new Capture(this, suppress ? null : console, false);
        error = new Capture(this, suppress ? null : stderr, true);
        Console.SetOut(output);
        Console.SetError(error);
    }

    private void Record(string line, bool isError)
    {
        if (failed) return;
        try
        {
            var now = DateTimeOffset.Now;
            file.WriteLine(json
                ? JsonSerializer.Serialize(new { level = isError ? 50 : 30, time = now.ToUnixTimeMilliseconds(), pid = Environment.ProcessId, hostname = Environment.MachineName, msg = line })
                : "[" + now.ToString("yyyy-MM-dd HH:mm:ss.fff ", CultureInfo.InvariantCulture) + now.ToString("zzz", CultureInfo.InvariantCulture).Replace(":", "") + "] " + (isError ? "ERROR" : "INFO") + ": " + line);
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
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try { file.Dispose(); }
            catch (IOException ex) { stderr.WriteLine("Main file logging failed: " + ex.Message); }
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
                else pending.Append(value);
            }
        }
        public override void Write(string? value)
        {
            if (value is null) return;
            lock (owner.gate) foreach (var character in value) Write(character);
        }
        public override void Flush() { lock (owner.gate) console?.Flush(); }
        internal void Finish()
        {
            if (pending.Length > 0) { owner.Record(pending.ToString(), isError); pending.Clear(); }
            console?.Flush();
        }
    }
}
