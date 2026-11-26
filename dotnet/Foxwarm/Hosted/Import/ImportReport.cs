using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Hosted.Import;

/// <summary>
/// The import report: what was read, written, verified and left behind. It can carry
/// configuration values (the dropped settings), so the file is created owner-only. Its JSON
/// shape is for operators and tests; the command prints a short summary of it.
/// </summary>
internal sealed class ImportReport
{
    private readonly Stopwatch clock = Stopwatch.StartNew();

    internal JsonObject Root { get; } = new()
    {
        ["tool"] = "foxwarm hosted import",
        ["version"] = ProductVersion.Value,
        ["startedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        ["outcome"] = "running",
        ["refusals"] = new JsonArray(),
        ["phases"] = new JsonArray(),
        ["verification"] = new JsonObject(),
        ["notImported"] = new JsonArray(),
        ["warnings"] = new JsonArray(),
    };

    internal string Outcome
    {
        get => Root["outcome"]!.GetValue<string>();
        set => Root["outcome"] = value;
    }

    internal JsonObject Verification => Root["verification"]!.AsObject();

    internal List<string> Failures { get; } = [];

    internal void Refuse(string message) => Root["refusals"]!.AsArray().Add(JsonValue.Create(message));

    internal IReadOnlyList<string> Refusals => Root["refusals"]!.AsArray().Select(item => item!.GetValue<string>()).ToArray();

    internal void Warn(string message) => Root["warnings"]!.AsArray().Add(JsonValue.Create(message));

    internal void NotImported(string what, long count, string reason) =>
        Root["notImported"]!.AsArray().Add(new JsonObject { ["what"] = what, ["count"] = count, ["reason"] = reason });

    /// <summary>Records a verification failure; any one keeps the tenant <c>importing</c>.</summary>
    internal void Fail(string message) => Failures.Add(message);

    /// <summary>Runs one phase and records its item count and duration.</summary>
    internal T Phase<T>(string name, Func<T> body, Func<T, long>? count = null)
    {
        var started = Stopwatch.GetTimestamp();
        var entry = new JsonObject { ["name"] = name, ["state"] = "running" };
        Root["phases"]!.AsArray().Add(entry);
        try
        {
            var result = body();
            entry["state"] = "done";
            if (count is not null)
                entry["items"] = count(result);
            return result;
        }
        catch
        {
            entry["state"] = "failed";
            throw;
        }
        finally
        {
            entry["seconds"] = Math.Round(Stopwatch.GetElapsedTime(started).TotalSeconds, 3);
        }
    }

    internal async Task<T> PhaseAsync<T>(string name, Func<Task<T>> body, Func<T, long>? count = null)
    {
        var started = Stopwatch.GetTimestamp();
        var entry = new JsonObject { ["name"] = name, ["state"] = "running" };
        Root["phases"]!.AsArray().Add(entry);
        try
        {
            var result = await body().ConfigureAwait(false);
            entry["state"] = "done";
            if (count is not null)
                entry["items"] = count(result);
            return result;
        }
        catch
        {
            entry["state"] = "failed";
            throw;
        }
        finally
        {
            entry["seconds"] = Math.Round(Stopwatch.GetElapsedTime(started).TotalSeconds, 3);
        }
    }

    internal void Finish()
    {
        Root["finishedAt"] = DateTimeOffset.UtcNow.ToString("O");
        Root["seconds"] = Math.Round(clock.Elapsed.TotalSeconds, 3);
        Root["verificationFailures"] = new JsonArray(Failures.Select(item => (JsonNode?)item).ToArray());
    }

    /// <summary>Writes <paramref name="text"/> to a new owner-only file.</summary>
    internal static void WritePrivate(string path, string text)
    {
        var full = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using var file = new FileStream(full, options);
        file.Write(new UTF8Encoding(false).GetBytes(text));
        file.Flush(true);
    }

    internal void Save(string path) => WritePrivate(path, Root.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }) + "\n");

    /// <summary>A few lines for stdout: outcome, tenant, phases, refusals and failures, and where the report is.</summary>
    internal string Summary(string reportPath)
    {
        var text = new StringBuilder();
        text.Append("Import ").Append(Outcome);
        if (Root["tenant"]?["name"] is { } tenant)
            text.Append(" for tenant ").Append(tenant.GetValue<string>());
        text.Append('.').AppendLine();
        foreach (var refusal in Refusals)
            text.Append("  refused: ").AppendLine(refusal);
        foreach (var phase in Root["phases"]!.AsArray().OfType<JsonObject>())
            text.Append("  ")
                .Append(phase["name"]!.GetValue<string>())
                .Append(": ")
                .Append(phase["state"]!.GetValue<string>())
                .Append(phase["items"] is { } items ? $", {items} items" : "")
                .Append($", {phase["seconds"]} s")
                .AppendLine();
        foreach (var failure in Failures.Take(20))
            text.Append("  verification failed: ").AppendLine(failure);
        if (Failures.Count > 20)
            text.Append("  … ").Append(Failures.Count - 20).AppendLine(" more verification failures in the report");
        var dropped = Root["configuration"]?["droppedSettings"]?.AsArray().Count ?? 0;
        if (dropped > 0)
            text.Append("  ").Append(dropped).AppendLine(" configuration settings hosted mode refuses were dropped; the report lists them with their values.");
        var notImported = Root["notImported"]!.AsArray().Count;
        if (notImported > 0)
            text.Append("  ").Append(notImported).AppendLine(" kinds of source data have no hosted owner and weren't imported; see notImported.");
        text.Append("Report (owner-only): ").AppendLine(reportPath);
        return text.ToString();
    }
}
